// Lightweight entry for agent hooks: loads only what a hook needs, not the whole CLI. Hooks run on every prompt
// and file edit, so startup time here is time added to the agent.
import { runHook } from './hook.ts';
import { hookClient } from './hookclient.ts';

const event = process.argv[2] ?? '';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;

const result = await runHook(event, stdin, async () => hookClient());
if (result.stdout) process.stdout.write(result.stdout + '\n');
if (result.stderr) process.stderr.write(result.stderr + '\n');
process.exitCode = result.code;
