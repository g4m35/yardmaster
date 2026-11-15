import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { tail } from './text.ts';

/** Positioned reads keep repeated detail refreshes independent of the log's full history. */
export function fileTail(file: string, lines: number, maxBytes = 200_000): string {
  let fd: number;
  try { fd = openSync(file, 'r'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw err; }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const bytes = Buffer.alloc(Math.min(size, maxBytes));
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, start + read);
      if (!n) break;
      read += n;
    }
    let offset = 0;
    // A suffix may begin inside a UTF-8 character; omit that fragment instead of inventing a replacement.
    if (start) while (offset < read && (bytes[offset]! & 0xc0) === 0x80) offset++;
    return tail(bytes.subarray(offset, read).toString('utf8'), lines, maxBytes);
  } finally { closeSync(fd); }
}
