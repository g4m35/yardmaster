import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { openDb, type Db } from './db.ts';
import { Coordinator } from './coordinator.ts';
import { buildMethods, dispatch, localClient, type Client, type Methods, type HubHooks } from './api.ts';
import { Integrator } from './integrator.ts';
import { WorkerLoop } from './worker.ts';
import { Semaphore } from './runner.ts';
import { recover, planCleanup, runCleanup } from './janitor.ts';
import { Supervisor } from './supervisor.ts';
import { inSea, readAsset } from './assets.ts';
import { importGraph } from './imports.ts';
import { loadConfig, newConfigWarnings, verifySlotsFor, worktreeRootOf } from './config.ts';
import { purgeTrash } from './fastfs.ts';
import { detectAgents } from './adapters/index.ts';
import { hubToken, machineId, paths } from './paths.ts';
import { acquireHubLock, holdsHubLock } from './hublock.ts';
import { git, revParse } from './git.ts';
import { loadPlugins, type LoadedPlugins } from './plugins.ts';
import { notify } from './notify.ts';
import { shortId } from './text.ts';
import type { YardEvent } from './types.ts';
import { VERSION } from './version.ts';
import { submitSessionHandoff } from './handoff.ts';
import { PairingStore, authorizeWorkerRpc, authorizeWorkerBaseBundle, authorizeWorkerUpload, type WorkerIdentity } from './pairing.ts';

const BRANCH_RE = /^yardmaster\/t-[a-z0-9]+$/;
const MAX_BUNDLE_BYTES = 2e9;

export interface HubOptions {
  host?: string;
  port?: number;
  db?: Db;
  token?: string;
  machineId?: string;
  includeMock?: boolean;
  tickMs?: number;
  quiet?: boolean;
}

export class Hub {
  readonly coord: Coordinator;
  readonly methods: Methods;
  private readonly httpMethods: Methods;
  readonly client: Client;
  readonly integrator: Integrator;
  readonly worker: WorkerLoop;
  readonly token: string;
  readonly machineId: string;
  private readonly pairing: PairingStore;
  private readonly nativeCaptures = new Map<string, Promise<unknown>>();
  private readonly captureAbort = new AbortController();
  private readonly background = new Set<Promise<unknown>>();
  private server: Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private lastNotified = 0;
  private plugins: LoadedPlugins = { adapters: [], notifiers: [], errors: [] };
  readonly supervisor: Supervisor;
  private looping = false;
  private again = false;
  private kickTimer: NodeJS.Timeout | null = null;
  private lastPressureClean = 0;
  private readonly opts: HubOptions;
  url = '';

  constructor(opts: HubOptions = {}) {
    this.opts = opts;
    this.coord = new Coordinator(opts.db ?? openDb());
    this.pairing = new PairingStore(this.coord.db, { ownerId: 'personal' });
    this.token = opts.token ?? hubToken();
    this.machineId = opts.machineId ?? machineId();
    const cfg = loadConfig();
    const verifySlots = new Semaphore(verifySlotsFor(cfg));
    // Merge checks get a slot of their own: a long combined test run must not hold up every finished task's checks.
    this.integrator = new Integrator(this.coord, new Semaphore(1));
    this.supervisor = new Supervisor(this.coord);
    const hooks: HubHooks = {
      machineId: this.machineId,
      captureNative: (params) => {
        if (this.captureAbort.signal.aborted) return Promise.reject(new Error('The hub is shutting down; native capture was not started.'));
        if (this.nativeCaptures.has(params.taskId)) return Promise.reject(new Error('Native capture is still in progress; inspect this task before retrying.'));
        const operation = Promise.resolve().then(() => submitSessionHandoff(this.coord, this.machineId, params, this.captureAbort.signal));
        this.nativeCaptures.set(params.taskId, operation);
        void operation.finally(() => this.nativeCaptures.delete(params.taskId)).catch(() => undefined);
        return operation;
      },
      supervisor: this.supervisor,
      stopRunning: (projectId) => {
        for (const a of this.worker.active.values()) if ((!projectId || a.task.project_id === projectId) && this.coord.getTask(a.task.id)?.status === 'running') a.stop?.('shutdown', 'Paused by you');
      },
      integrationHead: (projectId) => this.integrator.head(projectId),
      adoptIntegration: (projectId, head, by, note) => this.integrator.adopt(projectId, head, by, note),
      cleanPlan: (projectId) => planCleanup(this.coord, projectId),
      cleanRun: async (projectId) => runCleanup(this.coord, await planCleanup(this.coord, projectId)),
    };
    this.methods = buildMethods(this.coord, hooks);
    this.httpMethods = buildMethods(this.coord, { ...hooks, externalWorker: true });
    this.client = localClient(this.methods);
    const includeMock = opts.includeMock ?? process.env.YARDMASTER_ENABLE_MOCK === '1';
    this.worker = new WorkerLoop({
      client: this.client,
      machineId: this.machineId,
      name: `${hostname()} (hub)`,
      repos: () => Object.fromEntries(this.coord.listProjects().filter((p) => existsSync(p.root)).map((p) => [p.id, p.root])),
      agents: () => detectAgents(loadConfig(), includeMock),
      localConfig: () => loadConfig(),
      verifySlots,
      onDiskPressure: () => {
        if (this.captureAbort.signal.aborted) return Promise.resolve();
        const operation = this.relieveDisk();
        this.trackBackground(operation, 'Disk cleanup error');
        return operation;
      },
    });
  }

  private releaseLock: () => void = () => undefined;
  private lockFile = '';

  async start(): Promise<string> {
    // Before anything else: a second hub on this home would treat the first one's agents as orphans.
    this.lockFile = join(paths.home(), 'hub.lock');
    this.releaseLock = await acquireHubLock(this.lockFile);
    try {
      return await this.startLocked();
    } catch (err) {
      // Undo everything a partial start set up, so nothing schedules on behalf of a hub that never ran.
      this.coord.onChange = null;
      if (this.kickTimer) clearTimeout(this.kickTimer);
      for (const t of this.timers) clearInterval(t);
      await new Promise<void>((r) => (this.server?.listening ? this.server.close(() => r()) : r()));
      this.server = null;
      this.releaseLock();
      throw err;
    }
  }

  private async startLocked(): Promise<string> {
    await this.integrator.recoverTransfers();
    this.plugins = await loadPlugins();
    for (const e of this.plugins.errors) this.coord.event(null, null, 'warn', 'plugin.error', `Plugin in ${e.dir} failed to load: ${e.error}`);
    this.lastNotified = this.coord.lastEventId();
    this.coord.writeManagedRoots();
    const cfg = loadConfig();
    this.reportConfig();
    const host = this.opts.host ?? cfg.hub.host;
    const port = this.opts.port ?? cfg.hub.port;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    // Only once this hub is sure to run: recovery restarts work a previous hub left behind. Scheduling starts after
    // it, so a requeued task never gets a new agent while the old one is still exiting.
    await recover(this.coord, this.machineId, new Set(this.nativeCaptures.keys()), { startup: true });
    // Deletes a previous run didn't get to finish (it was killed, or the machine slept).
    purgeTrash(join(worktreeRootOf(cfg), '.trash'));
    this.coord.onChange = () => this.kick();
    const addr = this.server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    this.url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
    await this.heartbeat();
    const tick = this.opts.tickMs ?? 1500;
    let n = 0;
    this.timers.push(
      setInterval(() => {
        n++;
        this.trackBackground(this.loop(n), 'Hub loop error');
      }, tick),
    );
    if (!this.opts.quiet) this.coord.event(null, null, 'info', 'hub.started', `Hub started on ${this.url} (${this.worker.machineId})`);
    return this.url;
  }

  private async heartbeat() {
    this.coord.heartbeatMachine(this.machineId, `${hostname()} (hub)`, await this.worker.info(), true);
    for (const { task } of this.worker.active.values()) this.coord.renewLease(task.id, this.machineId, task.generation);
  }

  /**
   * React to a change right away (debounced a few ms): start newly runnable work and merge newly verified work.
   * The timer loop stays as a safety net and for periodic jobs.
   */
  kick(): void {
    if (this.kickTimer || !this.server || this.captureAbort.signal.aborted) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      this.trackBackground(this.react());
    }, 15);
    this.kickTimer.unref();
  }

  private async react(): Promise<void> {
    if (this.captureAbort.signal.aborted) return;
    if (this.looping) {
      this.again = true;
      return;
    }
    this.looping = true;
    try {
      await this.worker.tick();
      if (this.captureAbort.signal.aborted) return;
      for (const p of this.coord.listProjects()) if (existsSync(p.root)) void this.integrator.step(p.id);
    } finally {
      this.looping = false;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    }
  }

  /** Config problems (a broken file, unknown settings) as warnings; never a reason not to run. */
  private reportConfig(): void {
    for (const p of this.coord.listProjects()) {
      if (!existsSync(p.root)) continue;
      try {
        loadConfig(p.root);
      } catch (err) {
        const line = `${p.name}: ${(err as Error).message}`;
        if (this.invalidConfigs.has(line)) continue;
        this.invalidConfigs.add(line);
        this.coord.event(p.id, null, 'warn', 'config.invalid', line);
      }
    }
    for (const line of newConfigWarnings()) this.coord.event(null, null, 'warn', 'config.unknown', line);
  }

  private readonly invalidConfigs = new Set<string>();

  private async loop(n: number): Promise<void> {
    if (this.captureAbort.signal.aborted) return;
    // Never overlap ticks: a slow git call must not start a second scheduling pass alongside the first.
    if (this.looping) {
      this.again = true;
      return;
    }
    this.looping = true;
    try {
      if (n % 4 === 0 && !holdsHubLock(this.lockFile)) {
        // Another hub took over this home (only possible in a rare three-way start race): two hubs must never run.
        this.coord.event(null, null, 'error', 'hub.lock-lost', 'Another hub took over this Yardmaster home; this one is stopping.');
        void this.stop();
        return;
      }
      if (n % 3 === 0) await this.heartbeat();
      if (n % 20 === 0) this.reportConfig();
      await this.worker.tick();
      if (this.captureAbort.signal.aborted) return;
      // Merges (and their re-verification) run in the background so a long test run never stalls scheduling.
      for (const p of this.coord.listProjects()) if (existsSync(p.root)) void this.integrator.step(p.id);
      if (n % 4 === 0) await recover(this.coord, this.machineId, new Set([...this.worker.active.keys(), ...this.nativeCaptures.keys()]));
      if (this.captureAbort.signal.aborted) return;
      if (n % 7 === 0) this.supervisor.check();
      if (n % 20 === 1) this.trackBackground(this.refreshGraphs());
      if (n % 400 === 0 && loadConfig().cleanup.auto) this.cleanInBackground();
      this.dispatchNotifications();
    } finally {
      this.looping = false;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    }
  }

  private cleaning = false;

  /** Join admitted callbacks before shutdown releases the database/lock to its caller or a replacement hub. */
  private trackBackground(operation: Promise<unknown>, label = 'Hub error'): void {
    const completion = operation.catch(err => this.coord.event(null, null, 'error', 'hub.error', `${label}: ${(err as Error).message}`));
    this.background.add(completion);
    void completion.finally(() => this.background.delete(completion));
  }

  /** Routine cleanup never holds up scheduling: it runs beside the loop, one pass at a time, without sizing anything. */
  private cleanInBackground(): void {
    if (this.cleaning) return;
    this.cleaning = true;
    this.trackBackground(planCleanup(this.coord, undefined, { sizes: false })
      .then((plan) => runCleanup(this.coord, plan))
      .catch(() => undefined)
      .finally(() => {
        this.cleaning = false;
      }));
  }

  /** Import graphs feed coupling warnings in briefs and (optionally) scheduling. Rebuilt only when HEAD moves. */
  private async refreshGraphs(): Promise<void> {
    for (const p of this.coord.listProjects()) {
      if (this.captureAbort.signal.aborted) return;
      if (!existsSync(p.root) || this.coord.configFor(p.id).coupling === 'off') continue;
      try {
        this.coord.graphs.set(p.id, await importGraph(p.root));
      } catch {
        // A repo we can't read right now: coupling hints are simply skipped.
      }
    }
  }

  /** Disk is low or over quota: clean what is provably safe, oldest first, at most once a minute. */
  private async relieveDisk(): Promise<void> {
    if (Date.now() - this.lastPressureClean < 60_000) return;
    this.lastPressureClean = Date.now();
    const res = await runCleanup(this.coord, await planCleanup(this.coord));
    const freed = res.removed.reduce((n, i) => n + (i.bytes ?? 0), 0);
    if (freed > 0) this.coord.event(null, null, 'info', 'disk.reclaimed', `Freed ${(freed / 1e9).toFixed(2)} GB of finished worktrees, build output and old logs to make room.`);
  }

  private dispatchNotifications() {
    const events = this.coord.eventsSince(this.lastNotified, null, 200);
    if (!events.length) return;
    this.lastNotified = events[events.length - 1]!.id;
    const cfg = loadConfig();
    for (const e of events) {
      for (const n of this.plugins.notifiers) void Promise.resolve(n.onEvent(e)).catch(() => undefined);
      if (cfg.notify && (e.kind === 'task.needs_human' || e.kind === 'integration.conflict' && e.level === 'error')) notify('Yardmaster needs you', e.message);
    }
    const open = this.coord.listTasks(null, ['queued', 'running', 'verifying', 'ready', 'merging']);
    if (cfg.notify && !open.length && events.some((e: YardEvent) => e.kind === 'task.done')) notify('Yardmaster', 'All queued work is finished.');
  }

  async stop(): Promise<void> {
    this.captureAbort.abort('The hub is shutting down.');
    for (const t of this.timers) clearInterval(t);
    this.coord.onChange = null;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.worker.stopAll('shutdown', 'Yardmaster is shutting down');
    await Promise.all([this.worker.drain(), this.integrator.stop(), Promise.allSettled([...this.nativeCaptures.values()]), Promise.allSettled([...this.background])]);
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.releaseLock();
  }

  // ---------------- HTTP ----------------

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(this.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return this.serveDashboard(res);
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, name: 'yardmaster', version: VERSION });
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        try {
          const input = JSON.parse((await readBody(req, 2048)).toString('utf8')) as { code: string; machineId: string };
          const result = this.pairing.redeemInvitation(input.code, input.machineId);
          res.setHeader('cache-control', 'no-store');
          return json(res, 200, { ok: true, result });
        } catch { return json(res, 403, { ok: false, error: 'Pairing code is invalid, expired, revoked or already used. Create a new invitation on the owner hub.' }); }
      }
      const isOwner = this.authorized(req);
      const worker = isOwner ? null : this.pairing.authenticate((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      if (!isOwner && !worker) return json(res, 401, { ok: false, error: 'Missing, revoked, expired or wrong credential. Pair this machine again or use the owner dashboard link.' });

      const rpc = url.pathname.match(/^\/api\/rpc\/([\w.]+)$/);
      if (rpc && req.method === 'POST') {
        const body = await readBody(req, 5 * 1024 * 1024);
        try {
          const method = rpc[1]!;
          if (method === 'fleet.identity') {
            if (worker) authorizeWorkerBaseBundle(this.coord, worker, worker.projectId);
            return json(res, 200, { ok: true, result: worker ? { kind: 'worker', machineId: worker.machineId, projectId: worker.projectId, expiresAt: worker.expiresAt } : { kind: 'owner' } });
          }
          const params = body.length ? JSON.parse(body.toString('utf8')) : {};
          if (worker) authorizeWorkerRpc(this.coord, worker, method, params);
          const result = await dispatch(this.httpMethods, method, params);
          return json(res, 200, { ok: true, result: result ?? null });
        } catch (err) {
          return json(res, 200, { ok: false, error: (err as Error).message });
        }
      }
      if (url.pathname === '/api/stream' && req.method === 'GET') {
        if (worker) return json(res, 403, { ok: false, error: 'The dashboard event stream requires owner access.' });
        return this.stream(req, res, Number(url.searchParams.get('after') ?? 0));
      }

      const base = url.pathname.match(/^\/api\/projects\/([\w-]+)\/base-bundle$/);
      if (base && req.method === 'GET') {
        const guard = () => { if (worker) authorizeWorkerBaseBundle(this.coord, worker, base[1]!); };
        guard();
        return await this.sendBaseBundle(res, base[1]!, url.searchParams.get('have'), guard);
      }

      const up = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/bundle$/);
      if (up && req.method === 'POST') return await this.receiveBundle(req, res, up[1]!, url.searchParams.get('branch') ?? '', url.searchParams.get('machine') ?? '', url.searchParams.get('head') ?? '', Number(url.searchParams.get('generation')), worker);

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message });
    }
  }

  private serveDashboard(res: ServerResponse) {
    let html: string;
    try {
      const here = inSea ? '' : fileURLToPath(new URL('.', import.meta.url));
      html = readAsset('dashboard.html', inSea ? [] : [join(here, 'dashboard', 'index.html'), join(here, '..', 'src', 'dashboard', 'index.html')]);
    } catch {
      return json(res, 500, { ok: false, error: 'dashboard missing from install' });
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
  }

  private stream(req: IncomingMessage, res: ServerResponse, after: number) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    let last = after || this.coord.lastEventId();
    res.write(`event: hello\ndata: ${JSON.stringify({ last })}\n\n`);
    const timer = setInterval(() => {
      const events = this.coord.eventsSince(last, null, 200);
      if (events.length) {
        last = events[events.length - 1]!.id;
        res.write(`data: ${JSON.stringify(events)}\n\n`);
      } else {
        res.write(': keepalive\n\n');
      }
    }, 700);
    req.on('close', () => clearInterval(timer));
  }

  private async sendBaseBundle(res: ServerResponse, projectId: string, have: string | null, guard: () => void = () => {}) {
    const project = this.coord.getProject(projectId);
    if (!project) return json(res, 404, { ok: false, error: 'unknown project' });
    const branch = this.coord.configFor(projectId).integration.branch;
    await this.integrator.head(projectId);
    const file = join(paths.tmp(), `${shortId('b')}.bundle`);
    // Bundle under the integration lock so a merge in progress (not yet verified) is never shipped.
    await this.integrator.withLock(projectId, async () => {
      const args = ['bundle', 'create', file, `refs/heads/${branch}`];
      if (have && /^[0-9a-f]{7,40}$/.test(have) && (await revParse(project.root, have))) args.push(`^${have}`);
      const r = await git(project.root, args, { allowFail: true });
      // Nothing new relative to `have`: still send a complete bundle so the worker can proceed.
      if (r.code !== 0 || !existsSync(file)) await git(project.root, ['bundle', 'create', file, `refs/heads/${branch}`]);
    });
    guard();
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size, 'x-yardmaster-branch': branch });
    await pipeline(createReadStream(file), res);
    rmSync(file, { force: true });
  }

  private async receiveBundle(req: IncomingMessage, res: ServerResponse, taskId: string, branch: string, machine: string, head: string, generation: number, worker?: WorkerIdentity | null) {
    const task = this.coord.getTask(taskId);
    if (!task) return json(res, 404, { ok: false, error: 'unknown task' });
    if (!BRANCH_RE.test(branch) || branch !== task.branch) return json(res, 400, { ok: false, error: 'branch does not belong to this task' });
    // Only the machine that owns the current attempt may deliver it, and only the commit it verified.
    const guard = () => {
      this.coord.assertBundleOwner(taskId, machine, generation, head, branch);
      if (worker) authorizeWorkerUpload(this.coord, worker, { taskId, machineId: machine, generation, head, branch });
    };
    try { guard(); }
    catch (err) { return json(res, 409, { ok: false, error: (err as Error).message }); }
    if (!/^[0-9a-f]{40}$/.test(head) || head !== task.head_sha) return json(res, 409, { ok: false, error: 'commit does not match the verified one' });
    const length = Number(req.headers['content-length'] ?? 0);
    if (!length || length > MAX_BUNDLE_BYTES) return json(res, 413, { ok: false, error: `bundle must be between 1 byte and ${MAX_BUNDLE_BYTES / 1e9} GB` });
    const project = this.coord.getProject(task.project_id)!;
    const file = join(paths.tmp(), `${shortId('u')}.bundle`);
    try {
      let seen = 0;
      req.on('data', (c: Buffer) => {
        seen += c.length;
        if (seen > MAX_BUNDLE_BYTES) req.destroy(new Error('bundle too large'));
      });
      await pipeline(req, createWriteStream(file));
      guard();
      // Into a private namespace: never clobbers a branch that is checked out on the hub.
      // Isolate generations and concurrent requests; a stale stream cannot overwrite another delivery.
      const ref = `refs/yardmaster/receiving/${taskId}/${generation}/${shortId('u')}`;
      return await this.integrator.withTransfer(project.id, async () => {
      try {
      const r = await git(project.root, ['fetch', '--no-tags', file, `+refs/heads/${branch}:${ref}`], { allowFail: true });
      guard();
      if (r.code !== 0) return json(res, 200, { ok: false, error: `Could not import the branch: ${r.stderr.trim().slice(-300)}` });
      if ((await revParse(project.root, ref)) !== head) return json(res, 409, { ok: false, error: 'bundle does not contain the verified commit' });
      guard();
      // Retain an immutable generation-specific ref so garbage collection cannot discard acknowledged work.
      await git(project.root, ['update-ref', `refs/yardmaster/accepted/${taskId}/${generation}`, head]);
      guard();
      this.coord.setMeta(`bundle:${taskId}:${generation}`, JSON.stringify({ head, at: Date.now() }));
      this.coord.event(task.project_id, taskId, 'info', 'task.branch_received', `Received the verified work for "${task.title}" from ${this.coord.getMachine(machine)?.name ?? machine}`);
      return json(res, 200, { ok: true, result: { head, generation } });
      } finally { await git(project.root, ['update-ref', '-d', ref], { allowFail: true }); }
      });
    } catch (err) {
      return json(res, 409, { ok: false, error: (err as Error).message });
    } finally {
      rmSync(file, { force: true });
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function writeHubInfo(url: string): void {
  writeFileSync(paths.hubInfo(), JSON.stringify({ url, pid: process.pid, startedAt: Date.now() }, null, 2));
}

export function readHubInfo(): { url: string; pid: number; startedAt: number } | null {
  if (!existsSync(paths.hubInfo())) return null;
  try {
    return JSON.parse(readFileSync(paths.hubInfo(), 'utf8')) as { url: string; pid: number; startedAt: number };
  } catch {
    return null;
  }
}

export function clearHubInfo(): void {
  rmSync(paths.hubInfo(), { force: true });
}
