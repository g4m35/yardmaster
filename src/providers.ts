import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { runOwnedProcess, type OwnedRunOptions } from './proc.ts';
import { ProviderResultSchema, SERVICE_KINDS, type ProviderOperation, type ProviderPlugin, type ServicesConfig } from './provider-contract.ts';
import { serviceReceipt, type ServiceContext } from './service-receipts.ts';
import { BrowserbaseOptionsSchema, runBrowserbase } from './browserbase-provider.ts';

function browserbaseOperation(provider: string, op: ProviderOperation): boolean {
  return provider === 'browserbase' && op.command.at(-1) === '__browserbase-provider';
}

export interface ProviderCandidate {
  provider: string;
  capability: string;
  service: typeof SERVICE_KINDS[number];
  locality: 'local' | 'remote';
  cost: ProviderOperation['cost'];
  eligible: boolean;
  reasons: string[];
  /** Environment presence is checked, not sign-in, account entitlement or remaining quota. */
  authentication: 'not-checked';
}
export interface ServicePlan {
  capability: string;
  selected: string | null;
  candidates: ProviderCandidate[];
  unavailable: { provider: string; reason: string }[];
}

export function resolveProviderExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  // cmd/bat wrappers require a shell. Use the actual runtime and script path instead.
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) return null;
  const suffixes = platform === 'win32' && !extname(command)
    ? ['', ...new Set((env.PATHEXT ?? '.EXE;.COM').split(';').filter(ext => /^\.(exe|com)$/i.test(ext)).flatMap(ext => [ext.toLowerCase(), ext.toUpperCase()]))] : [''];
  const bases = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? [resolve(cwd, command)] : (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).map(dir => resolve(cwd, dir, command));
  const locations = bases.flatMap(base => suffixes.map(suffix => base + suffix));
  for (const file of locations) {
    try { if (statSync(file).isFile()) { accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return file; } } catch { /* next PATH entry */ }
  }
  return null;
}

function operationFor(provider: string, capability: string, services: ServicesConfig, plugins: ProviderPlugin[]): ProviderOperation | undefined {
  const capabilities = provider === 'local' ? services.local : plugins.find(p => p.name === provider)?.capabilities;
  const op = capabilities && Object.hasOwn(capabilities, capability) ? capabilities[capability] : undefined;
  if (op && browserbaseOperation(provider, op)) {
    const options = BrowserbaseOptionsSchema.safeParse(services.providers[provider]?.options ?? {});
    if (options.success) return { ...op, requiredEnv: [...new Set([...op.requiredEnv, ...options.data.requiredEnv])] };
  }
  return op;
}

export function planService(capability: string, services: ServicesConfig, plugins: ProviderPlugin[], cwd: string, env: NodeJS.ProcessEnv = process.env, input: unknown = {}): ServicePlan {
  const route = Object.hasOwn(services.routes, capability) ? services.routes[capability] : undefined;
  // Without a route only an explicitly configured local command is eligible.
  const prefer = [...new Set(route?.prefer ?? ['local'])];
  const candidates: ProviderCandidate[] = [];
  const unavailable: ServicePlan['unavailable'] = [];
  for (const provider of prefer) {
    const op = operationFor(provider, capability, services, plugins);
    if (!op) { unavailable.push({ provider, reason: 'provider is not installed or does not declare this capability' }); continue; }
    const reasons: string[] = [];
    if (provider !== 'local' && !services.providers[provider]?.enabled) reasons.push('provider is not enabled');
    if (provider === 'local' && (op.locality !== 'local' || op.cost !== 'free')) reasons.push('local commands must declare local execution and free service usage');
    if (route && route.locality !== 'any' && route.locality !== op.locality) reasons.push(`requires ${route.locality} execution`);
    if (!(route?.allowedCosts ?? ['free']).includes(op.cost)) reasons.push(`cost policy excludes ${op.cost} usage`);
    if (op.protocol === 'command' && (JSON.stringify(input) !== '{}' || Object.keys(services.providers[provider]?.options ?? {}).length)) reasons.push('exit-code commands cannot consume JSON input or provider options');
    if (!resolveProviderExecutable(op.command[0]!, cwd, env)) reasons.push('executable is missing or not executable');
    if (browserbaseOperation(provider, op)) {
      const browser = BrowserbaseOptionsSchema.safeParse(services.providers[provider]?.options ?? {});
      if (!browser.success) reasons.push('Browserbase needs valid options.command; timeoutSeconds must be 60–240');
      else if (!resolveProviderExecutable(browser.data.command[0]!, cwd, env)) reasons.push('configured browser test executable is missing or not executable');
    }
    for (const name of op.requiredEnv) {
      if (BLOCKED_ENV.has(name)) reasons.push(`environment variable ${name} cannot be forwarded to providers`);
      else if (!env[name]) reasons.push(`missing environment variable ${name}`);
    }
    candidates.push({ provider, capability, service: op.service, locality: op.locality, cost: op.cost,
      eligible: reasons.length === 0, reasons, authentication: 'not-checked' });
  }
  return { capability, selected: candidates.find(c => c.eligible)?.provider ?? null, candidates, unavailable };
}

export function providerInventory(services: ServicesConfig, plugins: ProviderPlugin[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const capabilities = [...new Set([...Object.keys(services.local), ...Object.keys(services.routes), ...plugins.flatMap(p => Object.keys(p.capabilities))])].sort();
  return {
    categories: [...SERVICE_KINDS],
    providers: [...new Set([...Object.keys(services.providers), ...plugins.map(p => p.name)])].filter(name => name !== 'local').sort().map(name => {
      const plugin = plugins.find(p => p.name === name);
      return { name, label: plugin?.label ?? name, installed: !!plugin, enabled: !!services.providers[name]?.enabled, capabilities: Object.keys(plugin?.capabilities ?? {}) };
    }),
    routes: capabilities.map(id => planService(id, services, plugins, cwd, env)),
  };
}

const BASE_ENV = ['PATH', 'HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot', 'COMSPEC', 'PATHEXT'];
const BLOCKED_ENV = new Set(['YARDMASTER_TOKEN', 'YARDMASTER_HUB', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']);

function redactValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [String(redactValue(key, secrets)), redactValue(child, secrets)]));
  return value;
}

/** Fallback happens before dispatch; a failed/unknown dispatched action is never replayed elsewhere. */
export async function runService(capability: string, input: unknown, services: ServicesConfig, plugins: ProviderPlugin[], options: {
  cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  context?: ServiceContext; onSpawn?: OwnedRunOptions['onSpawn'];
}) {
  const env = options.env ?? process.env;
  const plan = planService(capability, services, plugins, options.cwd, env, input);
  if (!plan.selected) throw new Error(`No eligible provider for ${capability}. Run "ym providers plan ${capability}" and configure a compatible provider or local command.`);
  const provider = plan.selected;
  const op = operationFor(provider, capability, services, plugins)!;
  if (op.protocol === 'command' && (JSON.stringify(input) !== '{}' || Object.keys(services.providers[provider]?.options ?? {}).length)) {
    throw new Error('Exit-code commands do not consume JSON input or provider options. Use the JSON protocol. No command was dispatched.');
  }
  // Resolve again immediately before dispatch, and never execute via a shell.
  const command = resolveProviderExecutable(op.command[0]!, options.cwd, env);
  if (!command) throw new Error('Selected provider executable is no longer available. No command was dispatched.');
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV, ...op.requiredEnv]) if (!BLOCKED_ENV.has(name) && env[name] !== undefined) childEnv[name] = env[name];
  const secrets = op.requiredEnv.map(name => childEnv[name]).filter((v): v is string => !!v).sort((a, b) => b.length - a.length);
  const requestId = randomUUID();
  // Validate size before allocating a receipt; it is not a record of an attempted dispatch yet.
  const request = { apiVersion: 1, requestId, capability, input, options: services.providers[provider]?.options ?? {} };
  if (Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024 - 4096) throw new Error('Provider input exceeds 1 MiB. No command was dispatched.');
  const receipt = serviceReceipt(requestId, { provider, capability, cwd: options.cwd, context: options.context ?? {} });
  const finish = <T extends Record<string, unknown>>(value: T) => { receipt.finish(value); return { ...value, receiptPath: receipt.file }; };
  const onSpawn: OwnedRunOptions['onSpawn'] = async process => { receipt.spawned({ pid: process.pid, startedAt: process.startedAt }); await options.onSpawn?.(process); };
  const envelope = JSON.stringify({ ...request, context: { ...options.context, evidenceDir: receipt.directory } });
  if (Buffer.byteLength(envelope) > 1024 * 1024) throw new Error('Provider input exceeds 1 MiB. No command was dispatched.');
  if (browserbaseOperation(provider, op)) {
    const browser = BrowserbaseOptionsSchema.parse(request.options);
    const command = resolveProviderExecutable(browser.command[0]!, options.cwd, childEnv);
    if (!command) throw new Error('Browser test executable disappeared. No session was dispatched.');
    const run = await runBrowserbase(browser, { command, cwd: options.cwd, env: childEnv,
      evidenceDir: receipt.directory, sha: options.context?.sha, input, signal: options.signal, onSpawn });
    const { pid, ...execution } = run.execution;
    return finish({ apiVersion: 1, requestId, provider, capability, dispatched: run.dispatched,
      execution, result: { ...run.result, summary: redactValue(run.result.summary, secrets) as string,
        data: redactValue(run.result.data, secrets), artifacts: run.result.artifacts.map(file => redactValue(file, secrets) as string) } });
  }
  let stdout = '';
  let outputBytes = 0;
  let outputTruncated = false;
  const tailLimit = 64 * 1024 + Math.max(0, ...secrets.map(secret => secret.length));
  const decoder = new StringDecoder('utf8');
  const execution = await runOwnedProcess(command, op.command.slice(1), {
    cwd: options.cwd, env: childEnv, stdin: op.protocol === 'json' ? envelope : undefined, timeoutMs: op.timeoutMs, signal: options.signal, onSpawn,
    onStdout: chunk => {
      outputBytes += chunk.length;
      if (op.protocol === 'json' && outputBytes > 1024 * 1024) throw new Error('Provider output exceeds 1 MiB');
      stdout += decoder.write(chunk);
      if (op.protocol === 'command' && stdout.length > 64 * 1024) { stdout = stdout.slice(-tailLimit).replace(/^[\uDC00-\uDFFF]/u, ''); outputTruncated = true; }
    },
    // Never echo provider stderr: third-party CLIs can include credentials or private request bodies.
  });
  stdout += decoder.end();
  const base = { apiVersion: 1, requestId, provider, capability, dispatched: execution.pid !== null,
    execution: { end: execution.end, code: execution.code, reaped: execution.reaped } };
  if (op.protocol === 'command' && execution.end === 'exit' && execution.reaped && execution.code !== null) {
    return finish({ ...base, result: { status: execution.code === 0 ? 'passed' as const : 'failed' as const,
      summary: execution.code === 0 ? 'Configured local command passed.' : `Configured local command failed (exit ${execution.code}).`,
      data: { stdout: (redactValue(stdout, secrets) as string).slice(-64 * 1024), truncated: outputTruncated }, artifacts: [], costUsd: null } });
  }
  if (execution.end !== 'exit' || execution.code !== 0 || !execution.reaped) {
    return finish({ ...base, result: { status: 'unknown' as const, summary: 'Provider did not complete cleanly. Inspect the service state before retrying; the action may have reached it.', artifacts: [], costUsd: null } });
  }
  try {
    const parsed = ProviderResultSchema.parse(JSON.parse(stdout));
    // Preserve the validated envelope/status; only provider-supplied content is redacted.
    const result = { ...parsed, summary: redactValue(parsed.summary, secrets) as string,
      data: redactValue(parsed.data, secrets), artifacts: parsed.artifacts.map(item => redactValue(item, secrets) as string) };
    return finish({ ...base, result });
  } catch {
    return finish({ ...base, result: { status: 'unknown' as const, summary: 'Provider returned an invalid result. The action may have reached the service; no fallback was attempted.', artifacts: [], costUsd: null } });
  }
}
