import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateDir, MAX_LINE_BYTES, MAX_PANES, overlayPanes, StatusBridge, type PushPane } from "./bridge.js";
import { buildTools, type ToolResult } from "./tools.js";
import type { OrcaResult } from "./orca.js";
import { mkdtempSync, scripted } from "./test/fake-orca.js";

const bridges: StatusBridge[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  sockets.splice(0).forEach((s) => s.destroy());
  bridges.splice(0).forEach((b) => b.stop());
});

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

async function listening() {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "orca-mcp-br-"))), "b");
  const b = new StatusBridge(join(dir, "1.sock"), dir);
  bridges.push(b);
  const started = await b.start();
  expect(started).toEqual({ ok: true, path: join(dir, "1.sock") });
  const sock = connect(b.path);
  sockets.push(sock);
  await new Promise<void>((r) => sock.once("connect", () => r()));
  await until(() => b.connected());
  return { b, sock, dir };
}

const status = (paneKey: string, state: string, receivedAt = 2_000_000) => JSON.stringify({ v: 1, event: "agent.status.changed", payload: { workspaceId: "r::/w/x", paneKey, state, receivedAt } });

describe("StatusBridge listener", () => {
  it("listens on a 0600 socket in a 0700 dir, takes NDJSON events and wakes waiters", async () => {
    const { b, sock, dir } = await listening();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(b.path).mode & 0o777).toBe(0o600);
    expect(b.connected()).toBe(true);
    const woke = b.changed(b.seq(), 2000);
    sock.write(`${JSON.stringify({ v: 1, event: "hello", payload: { plugin: "agent-status-bridge" } })}\n${status("tab:leaf", "waiting")}\n`);
    expect(await woke).toBe(true);
    expect(b.panes.get("tab:leaf")).toMatchObject({ state: "waiting", workspaceId: "r::/w/x", receivedAt: 2_000_000 });
    const before = b.seq();
    sock.write(`${JSON.stringify({ v: 1, event: "workspace.created", payload: { workspaceId: "r::/w/y", kind: "worktree", path: "/w/y", branch: "b" } })}\n`);
    await until(() => b.seq() > before);
    sock.write(`${JSON.stringify({ v: 1, event: "workspace.removed", payload: { workspaceId: "r::/w/x", kind: "worktree", path: "/w/x" } })}\n`);
    await until(() => !b.panes.has("tab:leaf"));
    expect(b.panes.has("tab:leaf")).toBe(false);
    sock.destroy();
    expect(await until(() => !b.connected())).toBe(true);
    expect(await b.changed(b.seq(), 20)).toBe(false);
  });

  it("drops malformed, unknown and oversized lines and keeps reading after them", async () => {
    const { b, sock } = await listening();
    sock.write("not json\n");
    sock.write(`${JSON.stringify({ v: 1, event: "agent.status.changed", payload: { paneKey: "p", state: "exploded", receivedAt: 1 } })}\n`);
    sock.write(`${JSON.stringify({ v: 2, event: "hello", payload: {} })}\n`);
    sock.write(`${JSON.stringify({ v: 1, event: "terminal.sendText", payload: { text: "rm -rf /" } })}\n`);
    // Over the cap with no newline yet: discarded up to the next newline, even though it ends in a valid-looking tail.
    sock.write("x".repeat(MAX_LINE_BYTES + 10));
    sock.write(`${status("big", "done")}\n`);
    sock.write(`${status("ok", "done")}\n`);
    await until(() => b.panes.has("ok"));
    expect([...b.panes.keys()]).toEqual(["ok"]);
    expect(b.dropped).toBe(5);
    expect(b.ingest("y".repeat(MAX_LINE_BYTES + 1))).toBe(false);
  });

  it("takes the worktree id Orca adds when the workspace id is missing", () => {
    const b = new StatusBridge("/nowhere.sock", undefined);
    expect(b.ingest(JSON.stringify({ v: 1, event: "agent.status.changed", payload: { workspaceId: null, worktreeId: "r::/w/z", paneKey: "p", state: "done", receivedAt: 5 } }))).toBe(true);
    expect(b.panes.get("p")?.workspaceId).toBe("r::/w/z");
  });

  it("refuses a dir or socket path another user could have planted, and replaces its own stale socket", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "orca-mcp-br-")));
    const foreign = ((p: string) => ({ ...lstatSync(p), isSymbolicLink: () => false, isDirectory: () => true, uid: (process.getuid?.() ?? 0) + 1 })) as unknown as typeof lstatSync;
    mkdirSync(join(base, "theirs"), { mode: 0o700 });
    expect(ensurePrivateDir(join(base, "theirs"), foreign)).toMatchObject({ error: expect.stringMatching(/belongs to uid/) });
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    expect(ensurePrivateDir(join(base, "link"))).toMatchObject({ error: expect.stringMatching(/not a directory/) });
    mkdirSync(join(base, "open"));
    chmodSync(join(base, "open"), 0o777);
    expect(ensurePrivateDir(join(base, "open"))).toEqual({ ok: true });
    expect(statSync(join(base, "open")).mode & 0o777).toBe(0o700);

    const dir = join(base, "sock");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "1.sock"), "");
    const otherOwner = ((p: string) => (p.endsWith(".sock") ? { ...lstatSync(p), uid: (process.getuid?.() ?? 0) + 1 } : lstatSync(p))) as unknown as typeof lstatSync;
    const refused = new StatusBridge(join(dir, "1.sock"), dir, otherOwner);
    expect(await refused.start()).toMatchObject({ error: expect.stringMatching(/exists and belongs to uid/) });
    const mine = new StatusBridge(join(dir, "1.sock"), dir);
    bridges.push(mine);
    expect(await mine.start()).toMatchObject({ ok: true });
    expect(lstatSync(join(dir, "1.sock")).isSocket()).toBe(true);
  });
});

describe("StatusBridge state", () => {
  it("refuses a receivedAt that is not finite or lies more than 5 min ahead", () => {
    const b = new StatusBridge("/nowhere.sock", "/nowhere", lstatSync, () => {}, () => 10_000_000);
    expect(b.ingest('{"v":1,"event":"agent.status.changed","payload":{"paneKey":"a","state":"done","receivedAt":1e400}}')).toBe(false);
    expect(b.ingest(status("b", "done", 10_000_000 + 6 * 60_000))).toBe(false);
    expect(b.ingest(status("c", "done", -5))).toBe(false);
    expect(b.ingest(status("d", "done", 10_000_000 + 60_000))).toBe(true);
    expect([...b.panes.keys()]).toEqual(["d"]);
  });

  it("keeps at most MAX_PANES panes and forgets old ones worktree ps no longer lists", () => {
    let t = 10_000_000;
    const b = new StatusBridge("/nowhere.sock", "/nowhere", lstatSync, () => {}, () => t);
    for (let i = 0; i < MAX_PANES + 88; i++) b.ingest(status(`p${i}`, "working", t - 1000));
    expect(b.panes.size).toBe(MAX_PANES);
    expect(b.panes.has("p0")).toBe(false);
    expect(b.panes.has(`p${MAX_PANES + 87}`)).toBe(true);
    t += 120_000;
    b.ingest(status("young", "working", t - 30_000));
    b.overlay([{ path: "/w/x", agents: [{ paneKey: "p100", state: "working" }] }]);
    // Old and unlisted: gone; listed, or too young to be listed yet: kept.
    expect(b.panes.size).toBe(2);
    expect([...b.panes.keys()].sort()).toEqual(["p100", "young"]);
  });

  it("sweeps its own dead sockets on start and leaves a live one alone", async () => {
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "orca-mcp-br-"))), "b");
    mkdirSync(dir, { mode: 0o700 });
    const dead = join(dir, "111.sock");
    // A server killed before it could unlink its socket.
    spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(dead)}, () => process.kill(process.pid, "SIGKILL"))`]);
    expect(lstatSync(dead).isSocket()).toBe(true);
    const live = new StatusBridge(join(dir, "222.sock"), dir);
    bridges.push(live);
    await live.start();
    expect(existsSync(dead)).toBe(false);
    const next = new StatusBridge(join(dir, "333.sock"), dir);
    bridges.push(next);
    await next.start();
    expect(existsSync(join(dir, "222.sock"))).toBe(true);
  });

  it("logs a server error after listening instead of throwing", async () => {
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "orca-mcp-br-"))), "b");
    const logged: string[] = [];
    const b = new StatusBridge(join(dir, "1.sock"), dir, lstatSync, (m) => logged.push(m));
    bridges.push(b);
    await b.start();
    (b as unknown as { server: Server }).server.emit("error", new Error("EPIPE later"));
    expect(logged).toEqual(["status bridge: EPIPE later"]);
  });
});

describe("push overlay", () => {
  it("a pushed state drops the row's message and tool, which belong to the state ps saw", () => {
    const [row] = overlayPanes([{ path: "/w/x", agents: [{ paneKey: "a", state: "working", stateStartedAt: 1000, lastAssistantMessage: "previous turn", toolName: "Bash" }] }], new Map([["a", { paneKey: "a", workspaceId: null, state: "done", receivedAt: 2000 }]]));
    expect(row!.agents![0]).toMatchObject({ state: "done", lastAssistantMessage: null, toolName: null, pushed: true });
  });

  const rows = [{ path: "/w/x", agents: [{ paneKey: "a", state: "working", stateStartedAt: 1000, updatedAt: 1500 }, { paneKey: "b", state: "working", stateStartedAt: 1000, updatedAt: 5000 }, { paneKey: "c", state: "done", stateStartedAt: 1000 }] }];
  it("a pushed state newer than the ps read wins; an older one or the same state changes nothing", () => {
    const panes = new Map<string, PushPane>([
      ["a", { paneKey: "a", workspaceId: null, state: "waiting", receivedAt: 2000 }],
      ["b", { paneKey: "b", workspaceId: null, state: "done", receivedAt: 3000 }],
      ["c", { paneKey: "c", workspaceId: null, state: "done", receivedAt: 9000 }],
    ]);
    const [row] = overlayPanes(rows, panes);
    expect(row!.agents![0]).toMatchObject({ state: "waiting", stateStartedAt: 2000, pushed: true });
    expect(row!.agents![1]).toEqual(rows[0]!.agents[1]);
    expect(row!.agents![2]).toEqual(rows[0]!.agents[2]);
  });
});

describe("tools with a connected plugin", () => {
  /** A plugin that pushes `waiting` for the pane on its first event while `worktree ps` still says working. */
  function fakePush(clock: { advance: (ms: number) => void }, connected = true) {
    const panes = new Map<string, PushPane>();
    let pushes = 0;
    return {
      waits: () => pushes,
      source: {
        connected: () => connected,
        seq: () => pushes,
        overlay: (r: Parameters<typeof overlayPanes>[0]) => overlayPanes(r, panes),
        changed: async (_since: number, ms: number) => {
          pushes++;
          clock.advance(Math.min(ms, 1000));
          panes.set("tab:leaf", { paneKey: "tab:leaf", workspaceId: "r::/w/x", state: "waiting", receivedAt: 2_000_000 });
          return true;
        },
      },
    };
  }
  const working: OrcaResult = { ok: true, result: { worktrees: [{ path: "/w/x", worktreeId: "r::/w/x", comment: "orca-mcp:tester", agents: [{ paneKey: "tab:leaf", agentType: "claude", state: "working", stateStartedAt: 1_000_000, updatedAt: 1_000_000 }] }] } };
  const shown: OrcaResult = { ok: true, result: { terminal: { handle: "term_1", tabId: "tab", leafId: "leaf" } } };

  it("orca_wait wakes on the plugin's push, not the poll interval, and sees a state ps has not caught up with", async () => {
    const clock = { advance: (_: number) => {} };
    const push = fakePush(clock);
    let slept = 0;
    const o = scripted({ "terminal show": [shown], "worktree ps": [working] }, { deps: { bridge: push.source, sleep: async () => void slept++ } });
    clock.advance = (ms) => void o.at(1_000_000 + ms);
    const r = await o.call("orca_terminal_wait", { terminal: "term_1", timeoutMs: 600_000 });
    expect(r).toMatchObject({ state: "waiting", data: { via: "hook" } });
    expect(push.waits()).toBe(1);
    expect(slept).toBe(0);
    expect(o.kinds().filter((k) => k === "worktree ps")).toHaveLength(2);
  });

  it("an event that lands during a slow worktree ps read wakes the next read at once (no lost wakeup)", async () => {
    const bridge = new StatusBridge("/nowhere.sock", "/nowhere");
    Object.assign(bridge, { connected: () => true });
    let reads = 0;
    const row = (state: string, msg?: string): OrcaResult => ({ ok: true, result: { worktrees: [{ path: "/w/x", agents: [{ paneKey: "tab:leaf", state, stateStartedAt: Date.now() - 1000, updatedAt: Date.now() + 60_000, ...(msg ? { lastAssistantMessage: msg } : {}) }, { paneKey: "other", state: "working", updatedAt: Date.now() + 60_000 }] }] } });
    const list = buildTools({
      orchestration: async () => false,
      capabilities: async () => new Set(),
      env: { HOME: "/nowhere", ORCA_MCP_ROOTS: "/nowhere", ORCA_MCP_CLIENT: "tester" },
      bridge,
      // Without the event counter the wait would sit out the 30 s safety interval; polling is off too.
      pollMs: 60_000,
      run: async (args) => {
        if (args[1] === "show") return shown;
        reads++;
        if (reads > 1) return row("done", "Finished.");
        await new Promise((r) => setTimeout(r, 20));
        // Mid-read: an event for another pane (same state ps reports, so nothing to overlay).
        bridge.ingest(status("other", "working", Date.now()));
        return row("working");
      },
    });
    const t0 = Date.now();
    const r = await (list.find((t) => t.name === "orca_terminal_wait")!.handler as (a: unknown) => Promise<ToolResult>)({ terminal: "term_1", timeoutMs: 600_000 });
    expect(r.structuredContent).toMatchObject({ state: "done", summary: "Agent done: Finished." });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(reads).toBe(2);
  });

  it("a pushed done never returns the previous turn's message: the wait reads again until ps has the new one", async () => {
    const clock = { advance: (_: number) => {} };
    const panes = new Map<string, PushPane>([["tab:leaf", { paneKey: "tab:leaf", workspaceId: "r::/w/x", state: "done", receivedAt: 2_000_000 }]]);
    const source = { connected: () => true, seq: () => 0, overlay: (r: Parameters<typeof overlayPanes>[0]) => overlayPanes(r, panes), changed: async () => true };
    const stale: OrcaResult = { ok: true, result: { worktrees: [{ path: "/w/x", agents: [{ paneKey: "tab:leaf", state: "working", stateStartedAt: 1_000_000, updatedAt: 1_000_000, lastAssistantMessage: "Previous turn." }] }] } };
    const fresh: OrcaResult = { ok: true, result: { worktrees: [{ path: "/w/x", agents: [{ paneKey: "tab:leaf", state: "done", stateStartedAt: 2_000_000, updatedAt: 2_000_000, lastAssistantMessage: "This turn." }] }] } };
    const o = scripted({ "terminal show": [shown], "worktree ps": [stale, fresh] }, { deps: { bridge: source } });
    clock.advance = (ms) => void o.at(1_000_000 + ms);
    const r = await o.call("orca_terminal_wait", { terminal: "term_1", timeoutMs: 600_000 });
    expect(r).toMatchObject({ state: "done", summary: "Agent done: This turn." });
    expect(r.text).not.toContain("Previous turn.");
  });

  it("orca_agent_status overlays pushed states and says so; without a plugin it polls", async () => {
    const clock = { advance: (_: number) => {} };
    const push = fakePush(clock);
    await push.source.changed(0, 0);
    const o = scripted({ "worktree ps": [working], "terminal list": [{ ok: true, result: { terminals: [{ handle: "term_1", tabId: "tab", leafId: "leaf" }] } }] }, { deps: { bridge: push.source } });
    expect(await o.call("orca_agent_status", {})).toMatchObject({ state: "waiting", data: { via: "push" } });
    const off = fakePush(clock, false);
    await off.source.changed(0, 0);
    const p = scripted({ "worktree ps": [working] }, { deps: { bridge: off.source } });
    expect(await p.call("orca_agent_status", {})).toMatchObject({ state: "working", data: { via: "poll" } });
  });
});
