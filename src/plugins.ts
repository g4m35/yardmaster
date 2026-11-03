import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as z from 'zod/v4';
import { registerAdapter } from './adapters/index.ts';
import type { Adapter, AgentEvent } from './adapters/types.ts';
import { DEFAULT_AGENTS } from './config.ts';
import { paths } from './paths.ts';
import type { YardEvent } from './types.ts';

/**
 * "Everything is a plugin", borrowed from DeepSeek Harness: agents, notifications, and checks are all
 * plugins with the same shape as the built-ins, and `ym plugin new` can have your own agent write one.
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

export const PluginSchema = z.discriminatedUnion('kind', [AdapterPluginSchema, NotifierPluginSchema]);
export type Plugin = z.infer<typeof PluginSchema>;

export interface LoadedPlugins {
  adapters: string[];
  notifiers: { name: string; onEvent: (e: YardEvent) => unknown }[];
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
  const out: LoadedPlugins = { adapters: [], notifiers: [], errors: [] };
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const entry = entryOf(dir);
    if (!entry) continue;
    try {
      const p = await loadPluginFile(entry);
      if (p.kind === 'adapter') {
        registerAdapter({ ...p, label: p.label ?? p.name } as unknown as Adapter);
        DEFAULT_AGENTS[p.name] ??= { enabled: true, models: {}, maxParallel: 2, extraArgs: [], autonomy: 'workspace' };
        out.adapters.push(p.name);
      } else {
        out.notifiers.push({ name: p.name, onEvent: p.onEvent as (e: YardEvent) => unknown });
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
      const spec = (plugin.build as Adapter['build'])({ prompt: 'Say hello', cwd: dir, model: null, settings: { enabled: true, models: {}, maxParallel: 1, extraArgs: [], autonomy: 'workspace' } });
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
  } else {
    try {
      await (plugin.onEvent as (e: YardEvent) => unknown)({ id: 0, project_id: null, task_id: null, level: 'info', kind: 'test', message: 'plugin test', data: null, ts: Date.now() });
      checks.push({ name: 'onEvent() accepts an event', ok: true });
    } catch (err) {
      checks.push({ name: 'onEvent() accepts an event', ok: false, detail: (err as Error).message });
    }
  }
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

const TEMPLATES: Record<'adapter' | 'notifier', (name: string) => string> = {
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

export function scaffoldPlugin(name: string, kind: 'adapter' | 'notifier', describe?: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Plugin names are lowercase letters, digits and dashes, starting with a letter.');
  const dir = join(paths.plugins(), name);
  if (existsSync(dir)) throw new Error(`${dir} already exists.`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mjs'), TEMPLATES[kind](name));
  writeFileSync(join(dir, 'PLUGIN_GUIDE.md'), GUIDE);
  if (describe) writeFileSync(join(dir, 'REQUEST.md'), `# What this plugin should do\n\n${describe}\n`);
  return dir;
}

export function creatorPrompt(name: string, kind: string, describe: string): string {
  return [
    `You are building a Yardmaster ${kind} plugin named "${name}" in the current directory.`,
    `What it should do: ${describe}`,
    'Read PLUGIN_GUIDE.md first. Edit index.mjs (plain ESM JavaScript, no dependencies).',
    `When done, run \`ym plugin test ${name}\` and fix problems until all checks pass. If you need to learn the target CLI's flags or output format, run its --help.`,
    'Finish with a one-paragraph summary of how the plugin works.',
  ].join('\n');
}
