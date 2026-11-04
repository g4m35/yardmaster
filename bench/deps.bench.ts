// Copying and deleting a big dependency folder: the old way (file by file) against Yardmaster 0.5 (one clone call,
// background delete). Pass a real node_modules to measure it, or let it build a synthetic one.
// Run: node bench/deps.bench.ts [path/to/node_modules] [files]
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cloneTree, removeFast } from '../src/fastfs.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ym-deps-bench-')));
let src = process.argv[2];
if (!src) {
  const files = Number(process.argv[3] ?? 40_000);
  src = join(root, 'node_modules');
  for (let i = 0; i < files; i++) {
    const d = join(src, `pkg${i % 400}`, 'lib');
    if (i < 400) mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `f${i}.js`), `module.exports = ${i};\n`);
  }
}
const count = Number(execFileSync('sh', ['-c', `find "${src}" -type f | wc -l`]).toString().trim());
const time = async (fn: () => unknown) => {
  const t = Date.now();
  await fn();
  return (Date.now() - t) / 1000;
};

const perFile = await time(() => execFileSync('cp', process.platform === 'darwin' ? ['-cR', src!, join(root, 'a')] : ['-R', '--reflink=auto', src!, join(root, 'a')]));
const whole = await time(() => cloneTree(src!, join(root, 'b')));
const del = await time(() => rmSync(join(root, 'a'), { recursive: true, force: true }));
const fastDel = await time(() => removeFast(join(root, 'b'), join(root, '.trash')));

console.log(`${count.toLocaleString()} files`);
console.log(`copy, file by file (cp${process.platform === 'darwin' ? ' -cR' : ' --reflink'}):  ${perFile.toFixed(2)} s`);
console.log(`copy, whole folder (Yardmaster):        ${whole.toFixed(2)} s`);
console.log(`delete (rm -rf):                        ${del.toFixed(2)} s`);
console.log(`delete (Yardmaster, finishes in background): ${fastDel.toFixed(3)} s`);
setTimeout(() => rmSync(root, { recursive: true, force: true }), 200);
