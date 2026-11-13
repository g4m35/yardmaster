import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as z from 'zod/v4';
import { registerAdapter } from './adapters/index.ts';
import type { Adapter, AgentEvent } from './adapters/types.ts';
import { DEFAULT_AGENTS, defaultAgentSettings } from './config.ts';
import { paths } from './paths.ts';
import type { YardEvent } from './types.ts';
import { ProviderPluginSchema, type ProviderPlugin } from './provider-contract.ts';

/**
 * Agent adapters, notifiers and service providers share discovery and validation.
 * Service plugins declare commands; discovery never dispatches those commands.
 */

const fn = z.custom<(...args: never[]) => unknown>((v) => typeof v === 'function', 'must be a function');

const AdapterPluginSchema = z.object({
  kind: z.literal('adapter'),
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().optional(),
  binary: z.string(),
  setupHint: z.string().optional(),
  build: fn,
  parse: fn,
  classifyFailure: fn.optional(),
});

const NotifierPluginSchema = z.object({
  kind: z.literal('notifier'),
  name: z.string(),
  /** Called for every event; filter inside. */
  onEvent: fn,
});

export const PluginSchema = z.discriminatedUnion('kind', [AdapterPluginSchema, NotifierPluginSchema, ProviderPluginSchema]);
export type Plugin = z.infer<typeof PluginSchema>;

export interface LoadedPlugins {
  adapters: string[];
  notifiers: { name: string; onEvent: (e: YardEvent) => unknown }[];
  providers: ProviderPlugin[];
  errors: { dir: string; error: string }[];
}

export async function loadPluginFile(file: string): Promise<Plugin> {
  const mod = (await import(pathToFileURL(file).href + `?t=${Date.now()}`)) as { default?: unknown };
  const parsed = PluginSchema.safeParse(mod.default);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

function entryOf(dir: string): string | null {
  for (const f of ['index.mjs', 'index.js']) if (existsSync(join(dir, f))) return join(dir, f);
  return null;
}

export async function loadPlugins(root = paths.plugins()): Promise<LoadedPlugins> {
  const out: LoadedPlugins = { adapters: [], notifiers: [], providers: [], errors: [] };
  const duplicateProviders = new Set<string>();
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const entry = entryOf(dir);
    if (!entry) continue;
    try {
      const p = await loadPluginFile(entry);
      if (p.kind === 'adapter') {
        registerAdapter({ ...p, label: p.label ?? p.name } as unknown as Adapter);
        DEFAULT_AGENTS[p.name] ??= defaultAgentSettings();
        out.adapters.push(p.name);
      } else if (p.kind === 'notifier') {
        out.notifiers.push({ name: p.name, onEvent: p.onEvent as (e: YardEvent) => unknown });
      } else {
        if (duplicateProviders.has(p.name) || out.providers.some(existing => existing.name === p.name)) {
          duplicateProviders.add(p.name);
          out.providers = out.providers.filter(existing => existing.name !== p.name);
          throw new Error(`Duplicate service provider ${p.name}; all copies disabled`);
        }
        out.providers.push(p);
      }
    } catch (err) {
      out.errors.push({ dir, error: (err as Error).message });
    }
  }
  return out;
}

/** Contract test used by `ym plugin test` and by Creator-mode generation before a plugin is accepted. */
export async function testPlugin(dir: string): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] }> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const entry = entryOf(dir);
  if (!entry) return { ok: false, checks: [{ name: 'has index.mjs', ok: false }] };
  let plugin: Plugin;
  try {
    plugin = await loadPluginFile(entry);
    checks.push({ name: 'loads and matches the plugin shape', ok: true });
  } catch (err) {
    return { ok: false, checks: [{ name: 'loads and matches the plugin shape', ok: false, detail: (err as Error).message }] };
  }
  if (plugin.kind === 'adapter') {
    try {
      const spec = (plugin.build as Adapter['build'])({ prompt: 'Say hello', cwd: dir, model: null, settings: defaultAgentSettings({ maxParallel: 1 }) });
      const ok = typeof spec?.command === 'string' && Array.isArray(spec.args) && spec.args.every((a) => typeof a === 'string');
      checks.push({ name: 'build() returns { command, args[] }', ok, detail: ok ? `${spec.command} ${spec.args.join(' ').slice(0, 80)}` : JSON.stringify(spec) });
      const promptPassed = spec.stdin === 'Say hello' || spec.args.some((a) => a.includes('Say hello'));
      checks.push({ name: 'prompt is passed to the agent', ok: promptPassed });
    } catch (err) {
      checks.push({ name: 'build() runs', ok: false, detail: (err as Error).message });
    }
    try {
      const samples = ['', 'plain text line', '{"type":"unknown"}', 'not json {'];
      const events = samples.flatMap((s) => (plugin.parse as Adapter['parse'])(s) as AgentEvent[]);
      const valid = events.every((e) => typeof e === 'object' && e && typeof (e as { type?: unknown }).type === 'string');
      checks.push({ name: 'parse() handles odd input without throwing', ok: valid });
    } catch (err) {
      checks.push({ name: 'parse() handles odd input without throwing', ok: false, detail: (err as Error).message });
    }
  } else if (plugin.kind === 'notifier') {
    try {
      await (plugin.onEvent as (e: YardEvent) => unknown)({ id: 0, project_id: null, task_id: null, level: 'info', kind: 'test', message: 'plugin test', data: null, ts: Date.now() });
      checks.push({ name: 'onEvent() accepts an event', ok: true });
    } catch (err) {
      checks.push({ name: 'onEvent() accepts an event', ok: false, detail: (err as Error).message });
    }
  } else checks.push({ name: 'provider manifest is valid (commands not executed; authentication not checked)', ok: true });
  return { ok: checks.every((c) => c.ok), checks };
}

const GUIDE = `# Writing a Yardmaster plugin

A plugin is a folder in ~/.yardmaster/plugins/<name>/ with an index.mjs whose default export is one object.
Run \`ym plugin test <name>\` until every check passes. Restart the hub (\`ym hub restart\`) to load it.

## kind: "adapter" (teach Yardmaster to drive another coding agent CLI)

    export default {
      kind: 'adapter',
      name: 'my-agent',            // lowercase, used in config and "agent" fields
      label: 'My Agent',
      binary: 'my-agent',          // looked up on PATH to detect installation
      setupHint: 'Install with ... and sign in with ...',
      build(ctx) {                 // ctx: { prompt, cwd, model, settings: { extraArgs, autonomy }, readOnly }
        return { command: 'my-agent', args: ['run', '--json', ...ctx.settings.extraArgs], stdin: ctx.prompt };
      },
      parse(line) {                // one stdout line -> zero or more events
        // Return [] for lines you don't understand. Never throw.
        // Events: { type: 'tool', name, input, write }   (write: true for file edits)
        //         { type: 'tool_result', ok, text }
        //         { type: 'text', text }
        //         { type: 'usage', tokensIn, tokensOut, cachedIn?, costUsd?, cumulative }
        //         { type: 'result', ok, text }           (final answer)
        //         { type: 'error', text }
        return [];
      },
      classifyFailure(output) {    // optional: 'auth' | 'rate_limit' | 'missing_binary' | 'context' | null
        return null;
      },
    };

Tool events drive loop detection, usage events drive budgets, result text becomes the task summary.

## kind: "notifier" (send updates somewhere)

    export default {
      kind: 'notifier',
      name: 'my-webhook',
      async onEvent(event) {       // { level, kind, message, task_id, project_id, ts }
        if (event.level !== 'error' && event.kind !== 'task.done') return;
        // post to Slack, ntfy.sh, a webhook...
      },
    };
`;

const PROVIDER_GUIDE = `
## kind: "provider" (use an optional service)

Declare apiVersion: 1, name, and capabilities. Each capability has service
(research, build, ci, browser, device, deploy, data, observability, notification),
command (executable and argv array), locality (local or remote), cost
(free, included, metered or unknown), requiredEnv (variable names only), and timeoutMs.
Use absolute helper-script paths derived from import.meta.url: commands run in the project directory.

Enable the provider in services.providers and select it in services.routes in yardmaster.json.
Installing a plugin does not enable it. Routes list candidates in explicit preference order;
local fallback must be named in that list. Without a route only services.local commands are considered.
allowedCosts defaults to ["free"]; included allowances and metered services must be explicitly allowed.

JSON protocol: read one object from stdin:
{ apiVersion: 1, requestId, capability, input, options }.
Write exactly one JSON object to stdout after the operation finishes:
{ status: "passed" | "failed" | "unknown", summary, data?, artifacts?: string[], costUsd?: number | null }.
Exit zero after writing this result, even for status failed; nonzero means a helper/protocol failure.
Use stderr for private diagnostics, which Yardmaster does not print. Do not put credentials in results.
An accepted remote job is not a passed test: wait for its terminal result.
Unknown or interrupted results never trigger automatic fallback/replay. Use requestId as an
idempotency key where supported. A remote adapter must manage its own remote job/session cleanup.
Free local commands may use protocol: "command" to report by exit code; they receive no JSON input/options.

ym providers list and plan inspect executable/environment presence, not authentication or account quota.
ym plugin test validates the manifest without executing provider commands. Real service integration
needs its own acceptance test. Plugins and configured commands are trusted local code, not sandboxed.
`;

const TEMPLATES: Record<'adapter' | 'notifier' | 'provider', (name: string) => string> = {
  provider: (name) => `// Declarative provider: implement provider.mjs using the JSON protocol in docs/PROVIDERS.md.
import { fileURLToPath } from 'node:url';
export default {
  kind: 'provider', apiVersion: 1, name: '${name}', label: '${name}',
  capabilities: {
    'verify': {
      service: 'ci', command: ['node', fileURLToPath(new URL('./provider.mjs', import.meta.url))],
      locality: 'remote', cost: 'unknown', requiredEnv: [], timeoutMs: 120000,
    },
  },
};
`,
  adapter: (name) => `// Yardmaster adapter plugin: ${name}. See PLUGIN_GUIDE.md.
export default {
  kind: 'adapter',
  name: '${name}',
  label: '${name}',
  binary: '${name}',
  build(ctx) {
    return { command: '${name}', args: [...ctx.settings.extraArgs], stdin: ctx.prompt };
  },
  parse(line) {
    const text = line.trim();
    return text ? [{ type: 'text', text }] : [];
  },
};
`,
  notifier: (name) => `// Yardmaster notifier plugin: ${name}. See PLUGIN_GUIDE.md.
export default {
  kind: 'notifier',
  name: '${name}',
  async onEvent(event) {
    if (event.level === 'error') console.error('[${name}]', event.message);
  },
};
`,
};

export function scaffoldPlugin(name: string, kind: 'adapter' | 'notifier' | 'provider', describe?: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Plugin names are lowercase letters, digits and dashes, starting with a letter.');
  if (kind === 'provider' && name === 'local') throw new Error('local is reserved for project commands.');
  const dir = join(paths.plugins(), name);
  if (existsSync(dir)) throw new Error(`${dir} already exists.`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mjs'), TEMPLATES[kind](name));
  writeFileSync(join(dir, 'PLUGIN_GUIDE.md'), GUIDE + PROVIDER_GUIDE);
  if (kind === 'provider') writeFileSync(join(dir, 'provider.mjs'), `// Replace this scaffold with the provider's API or CLI integration.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
console.log(JSON.stringify({ status: 'unknown', summary: 'Provider scaffold: implement the service request before use.', data: { requestId: request.requestId } }));
`);
  if (describe) writeFileSync(join(dir, 'REQUEST.md'), `# What this plugin should do\n\n${describe}\n`);
  return dir;
}

export function creatorPrompt(name: string, kind: string, describe: string): string {
  return [
    `You are building a Yardmaster ${kind} plugin named "${name}" in the current directory.`,
    `What it should do: ${describe}`,
    kind === 'provider' ? 'Read PLUGIN_GUIDE.md first. Implement provider.mjs and its index.mjs manifest (plain ESM JavaScript, no dependencies). The scaffold reports unknown until implemented.' : 'Read PLUGIN_GUIDE.md first. Edit index.mjs (plain ESM JavaScript, no dependencies).',
    `When done, run \`ym plugin test ${name}\` and fix problems until all checks pass. If you need to learn the target CLI's flags or output format, run its --help.`,
    'Finish with a one-paragraph summary of how the plugin works.',
  ].join('\n');
}
