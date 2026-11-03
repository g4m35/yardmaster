import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { selfCommand } from './connect.ts';
import { paths } from './paths.ts';
import { run } from './proc.ts';

/**
 * Process supervision for the hub itself: the OS service manager restarts it if it crashes and starts it at
 * login, so agents keep being supervised without anyone keeping a terminal open.
 */
export interface ServiceFiles {
  kind: 'launchd' | 'systemd';
  path: string;
  content: string;
}

const LABEL = 'dev.yardmaster.hub';

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function serviceFiles(host?: string, port?: string): ServiceFiles {
  const args = [...selfCommand(), 'hub', 'run', ...(host ? ['--host', host] : []), ...(port ? ['--port', port] : [])];
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir() };
  if (process.env.YARDMASTER_HOME) env.YARDMASTER_HOME = process.env.YARDMASTER_HOME;
  if (process.platform === 'darwin') {
    return {
      kind: 'launchd',
      path: join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(paths.hubLog())}</string>
  <key>StandardErrorPath</key><string>${xml(paths.hubLog())}</string>
</dict>
</plist>
`,
    };
  }
  const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`);
  return {
    kind: 'systemd',
    path: join(homedir(), '.config', 'systemd', 'user', 'yardmaster-hub.service'),
    content: `[Unit]
Description=Yardmaster hub (coordinates coding agents)
After=network-online.target

[Service]
ExecStart=${args.map(quote).join(' ')}
${Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`).join('\n')}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`,
  };
}

export async function installService(f: ServiceFiles): Promise<void> {
  mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, f.content);
  if (f.kind === 'launchd') {
    const uid = String(process.getuid?.() ?? '');
    await run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]).catch(() => undefined);
    const r = await run('launchctl', ['bootstrap', `gui/${uid}`, f.path]);
    if (r.code !== 0) throw new Error(`launchctl: ${r.stderr.trim()}`);
  } else {
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'yardmaster-hub.service']]) {
      const r = await run('systemctl', args);
      if (r.code !== 0) throw new Error(`systemctl ${args.join(' ')}: ${r.stderr.trim()}`);
    }
  }
}

export async function uninstallService(f: ServiceFiles): Promise<void> {
  if (f.kind === 'launchd') await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}/${LABEL}`]).catch(() => undefined);
  else await run('systemctl', ['--user', 'disable', '--now', 'yardmaster-hub.service']).catch(() => undefined);
  if (existsSync(f.path)) rmSync(f.path);
}
