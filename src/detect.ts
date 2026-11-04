import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { which } from './proc.ts';

/** The repo's obvious test command(s), for repos that haven't told us. */
export function detectVerify(root: string): string[] {
  const pkg = join(root, 'package.json');
  if (existsSync(pkg)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
      const runner = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb')) ? 'bun' : 'npm';
      const out: string[] = [];
      if (scripts.typecheck) out.push(`${runner} run typecheck`);
      if (scripts.test && !/no test specified/.test(scripts.test)) out.push(`${runner} test`);
      if (out.length) return out;
    } catch {
      // unreadable package.json: fall through
    }
  }
  if (existsSync(join(root, 'Cargo.toml'))) return ['cargo test'];
  if (existsSync(join(root, 'go.mod'))) return ['go test ./...'];
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'pytest.ini'))) return [which('uv') ? 'uv run pytest' : 'pytest'];
  return [];
}
