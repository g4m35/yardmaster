import { cpSync, chmodSync } from 'node:fs';
cpSync('src/dashboard', 'dist/dashboard', { recursive: true });
chmodSync('dist/cli.js', 0o755);
