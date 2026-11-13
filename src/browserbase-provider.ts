import * as z from 'zod/v4';
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { runOwnedProcess, type OwnedRunOptions } from './proc.ts';
import type { ProviderResult } from './provider-contract.ts';

export const BrowserbaseOptionsSchema = z.object({
  command: z.array(z.string().min(1)).min(1),
  projectId: z.string().min(1).optional(),
  timeoutSeconds: z.number().int().min(60).max(240).default(180),
  requiredEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  region: z.enum(['us-west-2', 'us-east-1', 'eu-central-1', 'ap-southeast-1']).optional(),
}).strict();

const API = 'https://api.browserbase.com/v1/sessions';
const TERMINAL = new Set(['COMPLETED', 'ERROR', 'TIMED_OUT']);

/** Direct REST, without SDK retries: a session-creation failure never starts a second session. */
export async function runBrowserbase(options: z.infer<typeof BrowserbaseOptionsSchema>, ctx: {
  command: string; cwd: string; env: NodeJS.ProcessEnv; evidenceDir: string; sha?: string | null;
  input: unknown; signal?: AbortSignal; onSpawn?: OwnedRunOptions['onSpawn'];
}, fetcher: typeof fetch = fetch) {
  const key = ctx.env.BROWSERBASE_API_KEY!;
  let session: { id: string; projectId?: string; connectUrl: string; expiresAt?: string } | undefined;
  let result: ProviderResult = { status: 'unknown', summary: 'Browser verification did not complete. Inspect the session before retrying.', artifacts: [], costUsd: null };
  let execution = { end: 'not-started', code: null as number | null, reaped: true, pid: null as number | null };
  let released = false;
  let dispatched = false;
  let output = '';
  let terminalStatus: string | null = null;
  const inputFile = join(ctx.evidenceDir, 'input.json');
  const request = async (url: string, body?: unknown, signal?: AbortSignal) => {
    const response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-BB-API-Key': key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Browserbase returned HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  };
  try {
    ctx.signal?.throwIfAborted();
    const input = JSON.stringify(ctx.input);
    writeFileSync(inputFile, input, { mode: 0o600 });
    dispatched = true;
    const created = await request(API, { ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.region ? { region: options.region } : {}), timeout: options.timeoutSeconds, keepAlive: false,
      browserSettings: { recordSession: false, logSession: false } },
    ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]) : undefined);
    // Keep the ID before validating connection details so malformed responses still trigger cleanup.
    if (typeof created.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(created.id)) throw new Error('Invalid Browserbase session ID');
    session = { id: created.id, connectUrl: typeof created.connectUrl === 'string' ? created.connectUrl : '',
      projectId: typeof created.projectId === 'string' ? created.projectId : options.projectId,
      expiresAt: typeof created.expiresAt === 'string' ? created.expiresAt : undefined };
    const socket = new URL(session.connectUrl);
    if (socket.protocol !== 'wss:' || !socket.hostname.endsWith('.browserbase.com')) throw new Error('Invalid Browserbase connection URL');
    writeFileSync(join(ctx.evidenceDir, 'session.json'), JSON.stringify({ provider: 'browserbase', id: session.id,
      expiresAt: session.expiresAt, timeoutSeconds: options.timeoutSeconds, state: 'running' }, null, 2), { mode: 0o600 });
    const artifacts = join(ctx.evidenceDir, 'artifacts');
    mkdirSync(artifacts, { mode: 0o700 });
    // The connection URL is a credential too. Only a trusted test command may receive it.
    const env: NodeJS.ProcessEnv = { ...ctx.env, CI: '1', BROWSERBASE_CDP_URL: session.connectUrl, BROWSERBASE_SESSION_ID: session.id,
      YARDMASTER_ARTIFACT_DIR: artifacts, YARDMASTER_VERIFY_SHA: ctx.sha ?? '', YARDMASTER_VERIFY_INPUT_FILE: inputFile };
    if (Buffer.byteLength(input) <= 32 * 1024) env.YARDMASTER_VERIFY_INPUT = input;
    else delete env.YARDMASTER_VERIFY_INPUT;
    delete env.BROWSERBASE_API_KEY;
    const decoder = new StringDecoder('utf8');
    const captureLimit = 64 * 1024 + Math.max(...[key, session.connectUrl, ...options.requiredEnv.map(name => ctx.env[name] ?? '')]
      .map(secret => Math.max(secret.length, encodeURIComponent(secret).length)));
    const run = await runOwnedProcess(ctx.command, options.command.slice(1), { cwd: ctx.cwd, env,
      timeoutMs: (options.timeoutSeconds - 15) * 1000, signal: ctx.signal, onSpawn: ctx.onSpawn,
      onStdout: chunk => { output = (output + decoder.write(chunk)).slice(-captureLimit); } });
    output += decoder.end();
    execution = { end: run.end, code: run.code, reaped: run.reaped, pid: run.pid };
    const clean = run.end === 'exit' && run.reaped && run.code !== null && !ctx.signal?.aborted;
    result = { status: clean ? (run.code === 0 ? 'passed' : 'failed') : 'unknown',
      summary: clean ? (run.code === 0 ? 'Configured browser tests passed.' : `Configured browser tests failed (exit ${run.code}).`) : 'Browser tests were interrupted or process cleanup was not confirmed. Inspect the session before retrying.',
      artifacts: [], costUsd: null };
  } catch {
    // Do not echo HTTP bodies, exception URLs, test stderr, or connection details.
    result.summary = session ? 'Browser verification could not finish. Inspect the recorded session before retrying.' : 'Browserbase session creation did not complete. A session may exist until its timeout; no fallback was attempted.';
  } finally {
    try { rmSync(inputFile, { force: true }); }
    catch { result = { ...result, status: 'unknown', summary: 'Browser input cleanup failed; inspect its private receipt directory before retrying.' }; }
    if (session) {
      try {
        const deadline = Date.now() + 10_000;
        let state: Record<string, unknown>;
        try {
          state = await request(`${API}/${encodeURIComponent(session.id)}`, { ...(session.projectId ? { projectId: session.projectId } : {}), status: 'REQUEST_RELEASE' });
        } catch {
          // A test client's browser.close() can already have completed the session. Observe it before deciding cleanup is unknown.
          state = await request(`${API}/${encodeURIComponent(session.id)}`, undefined, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
        }
        while (!TERMINAL.has(String(state.status)) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 250));
          state = await request(`${API}/${encodeURIComponent(session.id)}`, undefined, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
        }
        released = TERMINAL.has(String(state.status));
        terminalStatus = released ? String(state.status) : null;
      } catch { /* An unknown cleanup state must never pass. The session has a hard lifetime limit. */ }
      if (!released) result = { ...result, status: 'unknown', summary: 'Browserbase session release was not confirmed. Inspect the recorded session before retrying.' };
      else if (terminalStatus !== 'COMPLETED' && result.status === 'passed') result = { ...result, status: 'unknown', summary: `Browserbase ended with ${terminalStatus}; a passing test command does not certify this session.` };
      writeFileSync(join(ctx.evidenceDir, 'session.json'), JSON.stringify({ provider: 'browserbase', id: session.id,
        expiresAt: session.expiresAt, timeoutSeconds: options.timeoutSeconds, state: released ? 'released' : 'release-unconfirmed' }, null, 2), { mode: 0o600 });
    }
  }
  if (ctx.signal?.aborted) result = { ...result, status: 'unknown', summary: 'Browser verification was canceled. Inspect its receipt before retrying.' };
  const secrets = [key, session?.connectUrl, ...options.requiredEnv.map(name => ctx.env[name])].filter((s): s is string => !!s);
  secrets.push(...secrets.map(secret => encodeURIComponent(secret)));
  if (session?.connectUrl) {
    try { for (const [name, value] of new URL(session.connectUrl).searchParams) if (name !== 'sessionId' && value) secrets.push(value, encodeURIComponent(value)); }
    catch { /* Invalid connection details were already rejected. */ }
  }
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) output = output.split(secret).join('[redacted]');
  output = output.slice(-64 * 1024).replace(/^[\uDC00-\uDFFF]/u, '');
  writeFileSync(join(ctx.evidenceDir, 'command.log'), output, { mode: 0o600 });
  const artifactFiles: string[] = [];
  let entries = 0;
  const collect = (directory: string, depth = 0) => {
    if (depth > 10 || entries >= 1000) return;
    for (const name of readdirSync(directory)) {
      if (artifactFiles.length >= 99 || entries++ >= 1000) break;
      const file = join(directory, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) collect(file, depth + 1);
      else if (stat.isFile()) artifactFiles.push(file);
    }
  };
  collect(ctx.evidenceDir);
  return { dispatched, execution, result: { ...result, artifacts: artifactFiles.filter(file => !file.endsWith('/result.json')),
    data: { sessionId: session?.id ?? null, releaseConfirmed: released, terminalStatus, artifactSha: ctx.sha ?? null, stdout: output } } };
}
