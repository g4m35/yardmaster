// Text-only transfer avoids binary corruption/truncation in CLI and connector display layers.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectReceiptArchive } from './collect-hosted-verification.mjs';

const [, , sessionId, teamId, archive, sha256, target] = process.argv;
if (!sessionId || !teamId || !archive || !sha256 || !target) throw new Error('Usage: node scripts/export-hosted-verification.mjs SESSION_ID TEAM_ID REMOTE_ARCHIVE REMOTE_SHA256 LOCAL_ARCHIVE');
const temporary = mkdtempSync(join(tmpdir(), 'ym-receipt-transfer-'));
const api = (path, args = []) => {
  const run = spawnSync('vercel', ['api', path, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0) throw new Error('Receipt-transfer API request failed; keep the sandbox running and inspect the CLI error.');
  return run.stdout;
};
const route = `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd`;
const query = `?teamId=${encodeURIComponent(teamId)}`;
try {
  const request = join(temporary, 'request.json');
  writeFileSync(request, JSON.stringify({ command: 'node', args: ['-e',
    "const fs=require('node:fs'),b=fs.readFileSync(process.argv[1]);process.stdout.write(JSON.stringify({data:b.toString('base64'),size:b.length}));", archive], timeout: 10000 }), { mode: 0o600 });
  const started = JSON.parse(api(route + query, ['--method', 'POST', '--input', request]));
  const commandId = started.command?.id ?? started.result?.command?.id ?? started.id;
  if (!commandId) throw new Error('Export command identity missing; keep the sandbox running');
  const logs = api(`${route}/${encodeURIComponent(commandId)}/logs${query}`, ['--method', 'GET']);
  const stdout = logs.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.stream === 'stdout').map(entry => entry.data).join('');
  const result = collectReceiptArchive(JSON.parse(stdout), sha256, target);
  console.log(JSON.stringify(result));
} finally { rmSync(temporary, { recursive: true, force: true }); }
