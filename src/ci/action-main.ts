// Entry point of the GitHub Action (bundled into action/index.mjs by scripts/build-action.mjs).
import { appendFileSync, readFileSync } from 'node:fs';
import { createGitHub } from './github.ts';
import { contextFromEnv, decide, record, runIdFromUrl, type GuardContext } from './guard.ts';

const input = (name: string, fallback = ''): string => (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim();
// Logins never contain spaces; job names often do.
const list = (name: string, sep: RegExp): string[] => input(name).split(sep).map((s) => s.trim()).filter(Boolean);

function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value.replace(/[\r\n]+/g, ' ')}\n`);
}

function summary(text: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${text}\n`);
}

async function main(): Promise<void> {
  const token = input('token');
  if (!token) throw new Error('No token. The default is github.token; pass `token:` if you overrode it.');
  const gh = createGitHub(token);
  const payload = process.env.GITHUB_EVENT_PATH ? (JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) as GuardContext['payload']) : {};
  const ctx = contextFromEnv(process.env, payload);
  const mode = input('mode', 'check');
  if (mode === 'record') {
    const r = await record(gh, ctx);
    console.log(r.posted ? `Yardmaster: ${r.reason} (on ${r.sha.slice(0, 12)}).` : `::notice title=Yardmaster::${r.reason}`);
    return;
  }
  if (mode !== 'check') throw new Error(`Unknown mode "${mode}". Use "check" or "record".`);
  const d = await decide(gh, ctx, {
    trustLocal: input('trust-local', 'false') === 'true',
    trustedUsers: list('trusted-users', /[\s,]+/),
    waitSeconds: Number(input('wait-seconds', '20')) || 0,
    allowSkipped: list('allow-skipped', /[\n,]+/),
  });
  setOutput('skip', String(d.skip));
  setOutput('reason', d.reason);
  setOutput('tree', d.tree);
  // Only ever print a link to one of this repo's runs: the URL came from the API, but never echo arbitrary text.
  const url = d.url && runIdFromUrl(d.url, ctx.serverUrl, ctx.repo) ? ` (${d.url})` : '';
  const line = d.skip ? `Skipping the suite: ${d.reason}${url}.` : `Running the suite: ${d.reason}.`;
  console.log(`Yardmaster: ${line}`);
  summary(`**Yardmaster CI guard:** ${line}`);
}

main().catch((err: Error) => {
  // Failing open: if the guard can't decide, the suite runs. A broken guard must never skip checks.
  console.log(`::warning title=Yardmaster guard::${err.message.replace(/[\r\n]+/g, ' ')} (running the suite)`);
  setOutput('skip', 'false');
  setOutput('reason', `guard error: ${err.message}`);
});
