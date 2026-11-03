// Builds a standalone `yardmaster` executable (Node single-executable application): no Node or npm needed to run it.
//   node scripts/build-binary.mjs            -> release/yardmaster-<platform>-<arch>
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const platform = process.platform;
const arch = process.arch;
const out = 'release';
const work = join(out, '.work');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. One CommonJS file: the SEA entry point must be a single script.
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(work, 'yardmaster.cjs'),
  // Paths derived from import.meta.url are only used outside the binary; give it a harmless value.
  define: { 'import.meta.url': '"file:///yardmaster-sea/cli.js"' },
  logLevel: 'warning',
  legalComments: 'none',
});

// 2. The preparation blob, with the dashboard and skill embedded.
const blob = join(work, 'sea.blob');
writeFileSync(join(work, 'sea-config.json'), JSON.stringify({
  main: join(work, 'yardmaster.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
  // Off: Node documents that import() (used for plugins) does not work in code-cached SEAs.
  useCodeCache: false,
  execArgv: ['--no-warnings'],
  assets: { 'dashboard.html': 'src/dashboard/index.html', 'SKILL.md': 'skills/yardmaster/SKILL.md' },
}));
execFileSync(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')], { stdio: 'inherit' });

// 3. Inject into a copy of this Node binary.
const name = `yardmaster-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
const target = join(out, name);
copyFileSync(process.execPath, target);
chmodSync(target, 0o755);
if (platform === 'darwin') execFileSync('codesign', ['--remove-signature', target]);
const postject = ['node_modules/postject/dist/cli.js', target, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (platform === 'darwin') postject.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, postject, { stdio: 'inherit' });
// Apple Silicon refuses to run unsigned code; an ad-hoc signature is enough for a downloaded CLI.
if (platform === 'darwin') execFileSync('codesign', ['--sign', '-', target]);

const sum = createHash('sha256').update(readFileSync(target)).digest('hex');
writeFileSync(`${target}.sha256`, `${sum}  ${name}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`built ${target}`);
