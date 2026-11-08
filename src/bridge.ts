import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { PsRow } from "./agent-state.js";

/*
 * Push channel from the companion Orca plugin (plugin/): it forwards Orca's
 * `agent.status.changed`, `workspace.created` and `workspace.removed` events as
 * NDJSON lines `{ "v": 1, "event": <name>, "payload": <Orca's payload> }`.
 * Payload shapes: docs/reference/plugin-host-api.md#events in stablyai/orca.
 *
 * Every orca-mcp process (one per MCP client session) listens on its own socket
 * `<dir>/<pid>.sock` in a private per-user dir, and the plugin writes each event
 * to all of them: one shared path could serve only one process.
 */

export const MAX_LINE_BYTES = 64 * 1024;
const AGENT_STATES = new Set(["working", "blocked", "waiting", "done"]);
const WINDOWS = process.platform === "win32";

const uidOf = () => process.getuid?.() ?? userInfo().uid;

/** The per-user dir the sockets live in (POSIX); on Windows the named pipe namespace. */
export function bridgeDir(): string {
  return WINDOWS ? "\\\\.\\pipe\\" : join(tmpdir(), `orca-mcp-${uidOf()}`);
}

/** This process's socket (POSIX) or named pipe (Windows, best effort). */
export function bridgeSocketPath(dir = bridgeDir(), pid = process.pid): string {
  return WINDOWS ? `\\\\.\\pipe\\orca-mcp-${userInfo().username}-${pid}` : join(dir, `${pid}.sock`);
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
  /** `worktree ps` rows with every agent state the plugin reported after the row was read. */
  overlay(rows: PsRow[]): PsRow[];
  /** Resolves true on the next pushed change, false after `ms` or on abort. */
  changed(ms: number, signal?: AbortSignal): Promise<boolean>;
}

export function overlayPanes(rows: PsRow[], panes: ReadonlyMap<string, PushPane>): PsRow[] {
  return rows.map((row) => {
    if (!row.agents?.some((a) => a.paneKey && panes.has(a.paneKey))) return row;
    return {
      ...row,
      agents: row.agents.map((a) => {
        const p = a.paneKey ? panes.get(a.paneKey) : undefined;
        const seen = Math.max(typeof a.updatedAt === "number" ? a.updatedAt : 0, typeof a.stateStartedAt === "number" ? a.stateStartedAt : 0);
        if (!p || p.receivedAt <= seen || p.state === a.state) return a;
        return { ...a, state: p.state, stateStartedAt: p.mainAgent?.stateStartedAt ?? p.receivedAt, updatedAt: p.receivedAt, pushed: true };
      }),
    };
  });
}

export class StatusBridge implements PushSource {
  readonly panes = new Map<string, PushPane>();
  readonly workspaces = new Map<string, { path: string; branch?: string }>();
  /** Lines refused (malformed, oversized, unknown event). */
  dropped = 0;
  private server: Server | undefined;
  private readonly clients = new Set<Socket>();
  private readonly waiters = new Set<() => void>();

  constructor(
    readonly path: string = bridgeSocketPath(),
    private readonly dir: string | undefined = WINDOWS ? undefined : bridgeDir(),
    private readonly stat: typeof lstatSync = lstatSync,
  ) {}

  connected(): boolean {
    return this.clients.size > 0;
  }

  overlay(rows: PsRow[]): PsRow[] {
    return overlayPanes(rows, this.panes);
  }

  changed(ms: number, signal?: AbortSignal): Promise<boolean> {
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
        if (!paneKey || !state || !AGENT_STATES.has(state) || typeof p.receivedAt !== "number") return this.drop();
        const main = p.mainAgent as { state?: unknown; stateStartedAt?: unknown } | undefined;
        this.panes.set(paneKey, {
          paneKey,
          workspaceId: str(p.workspaceId) ?? null,
          ...(str(p.terminalId, 400) ? { terminalId: str(p.terminalId, 400)! } : {}),
          state,
          receivedAt: p.receivedAt,
          ...(main && typeof main === "object" ? { mainAgent: { ...(str(main.state, 40) ? { state: main.state as string } : {}), ...(typeof main.stateStartedAt === "number" ? { stateStartedAt: main.stateStartedAt } : {}) } } : {}),
        });
        break;
      }
      case "workspace.created": {
        const id = str(p.workspaceId);
        const path = str(p.path, 4096);
        if (!id || !path) return this.drop();
        this.workspaces.set(id, { path, ...(str(p.branch) ? { branch: str(p.branch)! } : {}) });
        break;
      }
      case "workspace.removed": {
        const id = str(p.workspaceId);
        if (!id) return this.drop();
        this.workspaces.delete(id);
        for (const [k, pane] of this.panes) if (pane.workspaceId === id) this.panes.delete(k);
        break;
      }
      default:
        return this.drop();
    }
    for (const w of [...this.waiters]) w();
    return true;
  }

  private drop(): false {
    this.dropped++;
    return false;
  }

  /** Listens on the socket; never throws, a refusal comes back as `error` and the server keeps polling. */
  start(): Promise<{ ok: true; path: string } | { error: string }> {
    if (this.dir) {
      const d = ensurePrivateDir(this.dir, this.stat);
      if ("error" in d) return Promise.resolve(d);
      try {
        const st = this.stat(this.path);
        if (st.uid !== uidOf()) return Promise.resolve({ error: `${this.path} exists and belongs to uid ${st.uid}` });
        // Ours, left by an earlier process with the same pid.
        unlinkSync(this.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") return Promise.resolve({ error: `cannot check ${this.path}: ${(err as Error).message}` });
      }
    }
    return new Promise((resolve) => {
      const server = createServer((sock) => this.accept(sock));
      server.once("error", (err) => resolve({ error: `cannot listen on ${this.path}: ${err.message}` }));
      server.listen(this.path, () => {
        if (!WINDOWS) chmodSync(this.path, 0o600);
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
    this.server?.close();
    this.server = undefined;
    if (!WINDOWS) {
      try {
        unlinkSync(this.path);
      } catch {
        // already gone
      }
    }
  }
}
