import type { ServerResponse } from 'node:http';
import type { YardEvent } from './types.ts';

interface Client {
  res: ServerResponse;
  last: number;
  blocked: boolean;
  close(): void;
}

export class EventStream {
  private readonly clients = new Set<Client>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private readonly source: { lastEventId(): number; eventsSince(after: number, projectId: null, limit: number): YardEvent[] };

  constructor(source: EventStream['source']) { this.source = source; }

  connect(res: ServerResponse, after: number): void {
    if (this.stopped) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const drain = () => { client.blocked = false; };
    const client: Client = { res, last: after || this.source.lastEventId(), blocked: false, close: () => {
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
    const events = this.source.eventsSince(after, null, 200);
    for (const client of ready) {
      const pending = events.filter(event => event.id > client.last);
      if (pending.length) client.last = pending[pending.length - 1]!.id;
      client.blocked = !client.res.write(pending.length ? `data: ${JSON.stringify(pending)}\n\n` : ': keepalive\n\n');
    }
  }

  close(): void {
    this.stopped = true;
    for (const client of this.clients) { client.close(); client.res.end(); }
  }
}
