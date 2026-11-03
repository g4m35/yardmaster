import { spawn } from 'node:child_process';
import { which } from './proc.ts';

/** Desktop notification so people don't have to watch a terminal. Message is passed as argv, never interpolated into a script. */
export function notify(title: string, message: string): void {
  try {
    if (process.platform === 'darwin' && which('osascript')) {
      spawn('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message.slice(0, 220)], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'linux' && which('notify-send')) {
      spawn('notify-send', [title, message.slice(0, 220)], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // Notifications are a convenience; the dashboard and CLI show the same information.
  }
}
