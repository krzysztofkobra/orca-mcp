import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PsRow } from "./agent-state.js";

/*
 * Push channel from the companion Orca plugin (plugin/): it forwards Orca's
 * `agent.status.changed`, `workspace.created` and `workspace.removed` events as
 * NDJSON lines `{ "v": 1, "event": <name>, "payload": <Orca's payload> }`.
 * POSIX only (see BRIDGE_SUPPORTED).
 * Payload shapes: docs/reference/plugin-host-api.md#events in stablyai/orca.
 *
 * Every orca-mcp process (one per MCP client session) listens on its own socket
 * `<dir>/<pid>.sock` in a private per-user dir, and the plugin writes each event
 * to all of them: one shared path could serve only one process.
 */

export const MAX_LINE_BYTES = 64 * 1024;
/** Panes kept at most; the oldest report goes first. */
export const MAX_PANES = 512;
/** A pushed pane `worktree ps` no longer lists is dropped once it is this old (a younger one may not be listed yet). */
const PRUNE_AFTER_MS = 60_000;
/** `receivedAt` further ahead than this is refused: both sides read the same machine's clock. */
const MAX_FUTURE_MS = 5 * 60_000;
const AGENT_STATES = new Set(["working", "blocked", "waiting", "done"]);
/**
 * Off on Windows: the named pipe namespace is shared by every user of the machine, so another
 * user could create a matching pipe first and receive the events. orca-mcp polls there.
 */
export const BRIDGE_SUPPORTED = process.platform !== "win32";

const uidOf = () => process.getuid?.() ?? -1;

/** The per-user dir the sockets live in. */
export function bridgeDir(): string {
  return join(tmpdir(), `orca-mcp-${uidOf()}`);
}

/** This process's socket. */
export function bridgeSocketPath(dir = bridgeDir(), pid = process.pid): string {
  return join(dir, `${pid}.sock`);
}

/**
 * Creates the bridge dir 0700, or accepts an existing one only when it is a real
 * directory owned by this user (tightening its mode if it is ours but open):
 * another local user must not be able to plant it or connect to sockets in it.
 */
export function ensurePrivateDir(dir: string, stat: typeof lstatSync = lstatSync): { ok: true } | { error: string } {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return { error: `cannot create ${dir}: ${(err as Error).message}` };
  }
  try {
    const st = stat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { error: `${dir} is not a directory` };
    if (st.uid !== uidOf()) return { error: `${dir} belongs to uid ${st.uid}, not this user` };
    if (st.mode & 0o077) chmodSync(dir, 0o700);
    return { ok: true };
  } catch (err) {
    return { error: `cannot check ${dir}: ${(err as Error).message}` };
  }
}

export type PushPane = {
  paneKey: string;
  workspaceId: string | null;
  terminalId?: string;
  state: string;
  receivedAt: number;
  mainAgent?: { state?: string; stateStartedAt?: number };
};

/** What the tools need from the bridge; a fake stands in for it in tests. */
export interface PushSource {
  /** A plugin is connected right now. */
  connected(): boolean;
  /** Counts accepted events; read it before a `worktree ps` read and hand it to `changed`. */
  seq(): number;
  /**
   * `worktree ps` rows with every agent state the plugin reported after the row was read.
   * Panes the rows no longer list are forgotten.
   */
  overlay(rows: PsRow[]): PsRow[];
  /** Resolves true at once when events arrived since `sinceSeq`, else on the next one; false after `ms` or on abort. */
  changed(sinceSeq: number, ms: number, signal?: AbortSignal): Promise<boolean>;
}

/**
 * Times compared here are one clock: `worktree ps` `updatedAt` is the status entry's
 * `receivedAt` (or `evidenceObservedAt`) and the event's `receivedAt` is the same entry's,
 * all `Date.now()` milliseconds in Orca's main process.
 */
export function overlayPanes(rows: PsRow[], panes: ReadonlyMap<string, PushPane>): PsRow[] {
  return rows.map((row) => {
    if (!row.agents?.some((a) => a.paneKey && panes.has(a.paneKey))) return row;
    return {
      ...row,
      agents: row.agents.map((a) => {
        const p = a.paneKey ? panes.get(a.paneKey) : undefined;
        const seen = Math.max(typeof a.updatedAt === "number" ? a.updatedAt : 0, typeof a.stateStartedAt === "number" ? a.stateStartedAt : 0);
        if (!p || p.receivedAt <= seen || p.state === a.state) return a;
        // The row's message and tool belong to the state ps saw, not the pushed one: a pushed done
        // carries no message, so a wait reads again until ps has caught up with the real one.
        return { ...a, state: p.state, stateStartedAt: p.mainAgent?.stateStartedAt ?? p.receivedAt, updatedAt: p.receivedAt, lastAssistantMessage: null, toolName: null, toolInput: null, pushed: true };
      }),
    };
  });
}

export class StatusBridge implements PushSource {
  readonly panes = new Map<string, PushPane>();
  /** Lines refused (malformed, oversized, unknown event). */
  dropped = 0;
  private events = 0;
  private server: Server | undefined;
  private readonly clients = new Set<Socket>();
  private readonly waiters = new Set<() => void>();

  constructor(
    readonly path: string = bridgeSocketPath(),
    private readonly dir: string = bridgeDir(),
    private readonly stat: typeof lstatSync = lstatSync,
    private readonly log: (msg: string) => void = (msg) => console.error(`orca-mcp: ${msg}`),
    private readonly clock: () => number = Date.now,
  ) {}

  connected(): boolean {
    return this.clients.size > 0;
  }

  seq(): number {
    return this.events;
  }

  overlay(rows: PsRow[]): PsRow[] {
    const listed = new Set(rows.flatMap((r) => (r.agents ?? []).flatMap((a) => (a.paneKey ? [a.paneKey] : []))));
    const cutoff = this.clock() - PRUNE_AFTER_MS;
    for (const [k, p] of this.panes) if (!listed.has(k) && p.receivedAt < cutoff) this.panes.delete(k);
    return overlayPanes(rows, this.panes);
  }

  changed(sinceSeq: number, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (this.events !== sinceSeq) return Promise.resolve(true);
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(false);
      const done = (v: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
        resolve(v);
      };
      const wake = () => done(true);
      const abort = () => done(false);
      const timer = setTimeout(() => done(false), ms);
      this.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** One NDJSON line from the plugin; returns whether it was accepted. */
  ingest(line: string): boolean {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.drop();
    let msg: { v?: unknown; event?: unknown; payload?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return this.drop();
    }
    const p = msg?.payload;
    if (!msg || msg.v !== 1 || !p || typeof p !== "object") return this.drop();
    const str = (v: unknown, max = 1000) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
    switch (msg.event) {
      case "hello":
        return true;
      case "agent.status.changed": {
        const paneKey = str(p.paneKey, 400);
        const state = str(p.state, 40);
        const at = p.receivedAt;
        if (!paneKey || !state || !AGENT_STATES.has(state) || typeof at !== "number" || !Number.isFinite(at) || at <= 0 || at > this.clock() + MAX_FUTURE_MS) return this.drop();
        const main = p.mainAgent as { state?: unknown; stateStartedAt?: unknown } | undefined;
        // Re-inserted so Map order stays oldest report first for the cap.
        this.panes.delete(paneKey);
        this.panes.set(paneKey, {
          paneKey,
          // Orca adds `worktreeId` beside `workspaceId` when it delivers the event.
          workspaceId: str(p.workspaceId) ?? str(p.worktreeId) ?? null,
          ...(str(p.terminalId, 400) ? { terminalId: str(p.terminalId, 400)! } : {}),
          state,
          receivedAt: at,
          ...(main && typeof main === "object"
            ? { mainAgent: { ...(str(main.state, 40) ? { state: main.state as string } : {}), ...(typeof main.stateStartedAt === "number" && Number.isFinite(main.stateStartedAt) ? { stateStartedAt: main.stateStartedAt } : {}) } }
            : {}),
        });
        while (this.panes.size > MAX_PANES) this.panes.delete(this.panes.keys().next().value!);
        break;
      }
      case "workspace.created":
        // Nothing to keep: the next `worktree ps` read lists it. It still wakes waits.
        if (!str(p.workspaceId) || !str(p.path, 4096)) return this.drop();
        break;
      case "workspace.removed": {
        const id = str(p.workspaceId);
        if (!id) return this.drop();
        for (const [k, pane] of this.panes) if (pane.workspaceId === id) this.panes.delete(k);
        break;
      }
      default:
        return this.drop();
    }
    this.events++;
    for (const w of [...this.waiters]) w();
    return true;
  }

  private drop(): false {
    this.dropped++;
    return false;
  }

  /** Our own sockets in the dir whose server is gone (connect refused): left by a crashed process. */
  private async sweepStale(): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".sock"));
    } catch {
      return;
    }
    await Promise.all(
      names.map(async (n) => {
        const path = join(this.dir, n);
        if (path === this.path) return;
        try {
          const st = this.stat(path);
          if (!st.isSocket() || st.uid !== uidOf()) return;
        } catch {
          return;
        }
        const alive = await new Promise<boolean>((resolve) => {
          const s = connect(path);
          const end = (v: boolean) => {
            clearTimeout(t);
            s.destroy();
            resolve(v);
          };
          const t = setTimeout(() => end(true), 1000);
          s.once("connect", () => end(true));
          s.once("error", (err: NodeJS.ErrnoException) => end(err.code !== "ECONNREFUSED" && err.code !== "ENOENT"));
        });
        if (!alive) {
          try {
            unlinkSync(path);
          } catch {
            // raced with another sweep
          }
        }
      }),
    );
  }

  /** Listens on the socket; never throws, a refusal comes back as `error` and the server keeps polling. */
  async start(): Promise<{ ok: true; path: string } | { error: string }> {
    if (!BRIDGE_SUPPORTED) return { error: "the status bridge is off on Windows (named pipes are shared between users)" };
    const d = ensurePrivateDir(this.dir, this.stat);
    if ("error" in d) return d;
    try {
      const st = this.stat(this.path);
      if (st.uid !== uidOf()) return { error: `${this.path} exists and belongs to uid ${st.uid}` };
      // Ours, left by an earlier process with the same pid.
      unlinkSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { error: `cannot check ${this.path}: ${(err as Error).message}` };
    }
    await this.sweepStale();
    return new Promise((resolve) => {
      const server = createServer((sock) => this.accept(sock));
      const refuse = (err: Error) => resolve({ error: `cannot listen on ${this.path}: ${err.message}` });
      server.once("error", refuse);
      server.listen(this.path, () => {
        server.off("error", refuse);
        // A later error (a dead client, the dir removed) must not crash the MCP server.
        server.on("error", (err) => this.log(`status bridge: ${err.message}`));
        chmodSync(this.path, 0o600);
        this.server = server;
        resolve({ ok: true, path: this.path });
      });
    });
  }

  private accept(sock: Socket): void {
    this.clients.add(sock);
    let buf = "";
    // Past the cap, everything up to the next newline is discarded.
    let skipping = false;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (skipping) skipping = false;
        else if (line.trim()) this.ingest(line);
      }
      if (Buffer.byteLength(buf) > MAX_LINE_BYTES) {
        if (!skipping) this.drop();
        skipping = true;
        buf = "";
      }
    });
    const gone = () => this.clients.delete(sock);
    sock.on("close", gone);
    sock.on("error", gone);
  }

  stop(): void {
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    if (!this.server) return;
    this.server.close();
    this.server = undefined;
    try {
      unlinkSync(this.path);
    } catch {
      // already gone
    }
  }
}
