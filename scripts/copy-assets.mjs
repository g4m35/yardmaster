import { cpSync, chmodSync } from 'node:fs';
cpSync('src/dashboard', 'dist/dashboard', { recursive: true });
chmodSync('dist/cli.js', 0o755);
chmodSync('bin/mock-agent.mjs', 0o755);
