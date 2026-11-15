import type { ServerResponse } from 'node:http';
import type { YardEvent } from './types.ts';
import type { StatementSync } from 'node:sqlite';
import type { Db } from './db.ts';

interface Client {
  res: ServerResponse;
  last: number;
  blocked: boolean;
  refreshedAt: number;
  close(): void;
}

export class EventStream {
  private readonly clients = new Set<Client>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private readonly events: StatementSync;
  private readonly latest: StatementSync;

  constructor(db: Db) {
    // eventsSince returns the newest page for the feed; stream replay needs the oldest unread page.
    this.events = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT 200');
    this.latest = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events');
  }

  connect(res: ServerResponse, after: number): void {
    if (this.stopped) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const drain = () => { client.blocked = false; };
    const client: Client = { res, last: after || Number(this.latest.get()!.id), blocked: false, refreshedAt: Date.now(), close: () => {
      this.clients.delete(client);
      res.off('drain', drain);
      res.off('close', client.close);
      if (!this.clients.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    } };
    this.clients.add(client);
    res.on('close', client.close);
    res.on('drain', drain);
    client.blocked = !res.write(`event: hello\ndata: ${JSON.stringify({ last: client.last })}\n\n`);
    this.timer ??= setInterval(() => this.poll(), 700);
  }

  private poll(): void {
    const ready = [...this.clients].filter(client => !client.blocked && !client.res.destroyed);
    if (!ready.length) return;
    // One bounded read serves every writable client, including replay after a slow client drains.
    const after = ready.reduce((last, client) => Math.min(last, client.last), Infinity);
    const rows = this.events.all(after) as unknown as (Omit<YardEvent, 'data'> & { data: string | null })[];
    const events = rows.map(row => ({ ...row, data: row.data ? JSON.parse(row.data) : null }));
    for (const client of ready) {
      const pending = events.filter(event => event.id > client.last);
      if (pending.length) client.last = pending[pending.length - 1]!.id;
      let frame = pending.length ? `data: ${JSON.stringify(pending)}\n\n` : ': keepalive\n\n';
      // Machine/session records and time-based freshness can change without durable events.
      if (Date.now() - client.refreshedAt >= 30_000) {
        frame += 'event: refresh\ndata: {}\n\n';
        client.refreshedAt = Date.now();
      }
      client.blocked = !client.res.write(frame);
    }
  }

  close(): void {
    this.stopped = true;
    for (const client of this.clients) { client.close(); client.res.end(); }
  }
}
