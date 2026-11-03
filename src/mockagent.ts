// Deterministic stand-in for a coding agent. Reads the prompt on stdin and executes `@mock` directives,
// emitting Yardmaster's normalized event format. Used by the test-suite and `ym demo`, and runs the same way
// from the npm package and from the standalone binary (`ym __mock-agent`).
//
//   @mock write <path> <text>        create/overwrite a file (\n escapes allowed)
//   @mock append <path> <text>       append to a file
//   @mock sleep <ms>
//   @mock cost <usd>                 report spend
//   @mock loop                       repeat the same tool call forever
//   @mock oscillate                  alternate between two calls forever
//   @mock stall                      go silent
//   @mock ask                        ask the user a question, then wait
//   @mock fail <message>             exit non-zero
//   @mock attempt <n> <directive...> only run the directive on attempt n (YARDMASTER_ATTEMPT)
//   @mock unless-prompt <word> <directive...>  skip the directive if the prompt mentions <word>
//   @mock git <args...>              run git in the worktree (e.g. to misbehave on purpose)
//   @mock-review <round> <approve|changes> <note>  how to answer when asked to review
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

type Emitted = Record<string, unknown>;

export async function runMockAgent(): Promise<void> {
  const emit = (ev: Emitted) => process.stdout.write(JSON.stringify(ev) + '\n');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;

  const attempt = Number(process.env.YARDMASTER_ATTEMPT ?? '1');
  const lines = prompt.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('@mock '));

  async function exec(words: string[]): Promise<void> {
    const [cmd, ...rest] = words;
    switch (cmd) {
      case 'attempt': {
        const [n, ...inner] = rest;
        if (Number(n) === attempt) await exec(inner);
        return;
      }
      case 'unless-prompt': {
        const [word = '', ...inner] = rest;
        const plain = prompt.split('\n').filter((l) => !l.trim().startsWith('@mock ')).join('\n');
        if (!plain.includes(word)) await exec(inner);
        return;
      }
      case 'git':
        emit({ type: 'tool', name: 'Bash', input: { command: `git ${rest.join(' ')}` }, write: false });
        execFileSync('git', rest, { stdio: 'ignore' });
        return;
      case 'write':
      case 'append': {
        const [path = 'mock-output.txt', ...text] = rest;
        const body = text.join(' ').replace(/\\n/g, '\n');
        emit({ type: 'tool', name: cmd === 'write' ? 'Write' : 'Edit', input: { file_path: path }, write: true });
        mkdirSync(dirname(path), { recursive: true });
        if (cmd === 'write') writeFileSync(path, body + '\n');
        else appendFileSync(path, body + '\n');
        emit({ type: 'tool_result', ok: true, text: 'ok' });
        await sleep(20);
        return;
      }
      case 'sleep':
        await sleep(Number(rest[0] ?? 100));
        return;
      case 'cost':
        emit({ type: 'usage', tokensIn: 1000, tokensOut: 100, costUsd: Number(rest[0] ?? 0.01), cumulative: false });
        return;
      case 'loop':
        for (;;) {
          emit({ type: 'tool', name: 'Read', input: { file_path: 'package.json' }, write: false });
          emit({ type: 'tool_result', ok: true, text: '{}' });
          await sleep(30);
        }
      case 'oscillate':
        for (let i = 0; ; i++) {
          emit({ type: 'tool', name: 'Bash', input: { command: i % 2 ? 'git checkout -- a' : 'sed -i s/x/y/ a' }, write: false });
          emit({ type: 'tool_result', ok: true, text: '' });
          await sleep(30);
        }
      case 'stall':
        await sleep(10 * 60_000);
        return;
      case 'ask':
        emit({ type: 'text', text: 'Should I also update the database schema? Please confirm before I continue.' });
        await sleep(10 * 60_000);
        return;
      case 'fail':
        emit({ type: 'error', text: rest.join(' ') || 'mock failure' });
        process.exit(1);
      default:
        emit({ type: 'text', text: `unknown directive ${cmd}` });
    }
  }

  // Acting as a reviewer: answer from `@mock-review <round> <approve|changes> <note...>` lines in the request.
  if (prompt.includes('YARDMASTER-REVIEW')) {
    const round = Number(process.env.YARDMASTER_REVIEW_ROUND ?? '0');
    const rules = prompt.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('@mock-review '));
    const rule = rules.map((l) => l.split(/\s+/)).find((w) => Number(w[1]) === round);
    const verdict = rule && rule[2] === 'changes' ? 'request_changes' : 'approve';
    const issues = verdict === 'request_changes' && rule ? [{ severity: 'major', file: 'n/a', note: rule.slice(3).join(' ') || 'please fix' }] : [];
    emit({ type: 'usage', tokensIn: 300, tokensOut: 40, costUsd: 0.002, cumulative: false });
    emit({ type: 'result', ok: true, text: JSON.stringify({ verdict, issues, summary: 'mock review' }) });
    return;
  }

  emit({ type: 'text', text: `mock agent starting (attempt ${attempt})` });
  for (const line of lines) await exec(line.slice(6).split(/\s+/));
  emit({ type: 'usage', tokensIn: 500, tokensOut: 50, cumulative: false });
  emit({ type: 'result', ok: true, text: `Mock agent finished ${lines.length} step(s).` });
}
