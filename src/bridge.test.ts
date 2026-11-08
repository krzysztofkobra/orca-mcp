import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateDir, MAX_LINE_BYTES, overlayPanes, StatusBridge, type PushPane } from "./bridge.js";
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
    const woke = b.changed(2000);
    sock.write(`${JSON.stringify({ v: 1, event: "hello", payload: { plugin: "agent-status-bridge" } })}\n${status("tab:leaf", "waiting")}\n`);
    expect(await woke).toBe(true);
    expect(b.panes.get("tab:leaf")).toMatchObject({ state: "waiting", workspaceId: "r::/w/x", receivedAt: 2_000_000 });
    sock.write(`${JSON.stringify({ v: 1, event: "workspace.created", payload: { workspaceId: "r::/w/y", kind: "worktree", path: "/w/y", branch: "b" } })}\n`);
    await until(() => b.workspaces.has("r::/w/y"));
    sock.write(`${JSON.stringify({ v: 1, event: "workspace.removed", payload: { workspaceId: "r::/w/x", kind: "worktree", path: "/w/x" } })}\n`);
    await until(() => !b.panes.has("tab:leaf"));
    expect(b.panes.has("tab:leaf")).toBe(false);
    sock.destroy();
    expect(await until(() => !b.connected())).toBe(true);
    expect(await b.changed(20)).toBe(false);
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

describe("push overlay", () => {
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
        overlay: (r: Parameters<typeof overlayPanes>[0]) => overlayPanes(r, panes),
        changed: async (ms: number) => {
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

  it("orca_agent_status overlays pushed states and says so; without a plugin it polls", async () => {
    const clock = { advance: (_: number) => {} };
    const push = fakePush(clock);
    await push.source.changed(0);
    const o = scripted({ "worktree ps": [working], "terminal list": [{ ok: true, result: { terminals: [{ handle: "term_1", tabId: "tab", leafId: "leaf" }] } }] }, { deps: { bridge: push.source } });
    expect(await o.call("orca_agent_status", {})).toMatchObject({ state: "waiting", data: { via: "push" } });
    const off = fakePush(clock, false);
    await off.source.changed(0);
    const p = scripted({ "worktree ps": [working] }, { deps: { bridge: off.source } });
    expect(await p.call("orca_agent_status", {})).toMatchObject({ state: "working", data: { via: "poll" } });
  });
});
