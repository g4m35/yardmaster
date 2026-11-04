// Lightweight entry for agent hooks: loads only what a hook needs, not the whole CLI. Hooks run on every prompt
// and file edit, so startup time here is time added to the agent.
import { existsSync, readFileSync } from 'node:fs';
import { runHook } from './hook.ts';
import { remoteClient } from './rpc.ts';
import { paths, yardHome } from './paths.ts';
import { join } from 'node:path';

const event = process.argv[2] ?? '';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;

const result = await runHook(event, stdin, async () => {
  const remote = process.env.YARDMASTER_HUB;
  const tokenFile = join(yardHome(), 'token');
  const token = process.env.YARDMASTER_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
  if (remote) return remoteClient(remote, token, { timeoutMs: 1500 });
  if (!existsSync(paths.hubInfo()) || !token) return null;
  const { url } = JSON.parse(readFileSync(paths.hubInfo(), 'utf8')) as { url: string };
  return remoteClient(url, token, { timeoutMs: 1500 });
});
if (result.stdout) process.stdout.write(result.stdout + '\n');
if (result.stderr) process.stderr.write(result.stderr + '\n');
process.exitCode = result.code;
