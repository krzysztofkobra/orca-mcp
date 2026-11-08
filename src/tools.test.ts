import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityProbe, EXTERNAL_COORDINATOR_CAPABILITY, orchestrationProbe } from "./capabilities.js";
import { runOrca, type OrcaResult } from "./orca.js";
import { ownerComment, ownerOf } from "./agent-state.js";
import type { PushSource } from "./bridge.js";
import { buildTools, type ToolResult } from "./tools.js";
import { fakeOrca, fakeTools, scripted } from "./test/fake-orca.js";

describe("tools over the fake binary", () => {
  it("orca_worktree_create builds the exact argv, tags the worktree and returns the worker", async () => {
    const f = fakeOrca({
      "worktree create": { stdout: { ok: true, result: { agentTerminalHandle: "term_1", worktree: { path: "/w/fix-readme", branch: "refs/heads/fix-readme" } } } },
    });
    const r = await fakeTools(f).call("orca_worktree_create", { repo: join(f.devRoot, "repo"), name: "fix-readme", agent: "claude", prompt: "--force; add a line", model: "claude-sonnet-5-5", effort: "low" });
    expect(r.isError).toBe(false);
    expect(f.calls()[0]!.argv).toEqual([
      "worktree",
      "create",
      "--name=fix-readme",
      `--repo=path:${join(f.devRoot, "repo")}`,
      "--agent=claude",
      "--prompt=--force; add a line",
      "--no-parent",
      "--comment=orca-mcp:tester",
      "--model=claude-sonnet-5-5",
      "--effort=low",
      "--json",
    ]);
    expect(r.state).toBe("working");
    expect(r.text.split("\n")[0]).toBe("working: Worktree /w/fix-readme created on fix-readme, claude started in terminal term_1.");
    expect(r.data.worker).toMatchObject({ key: "term:term_1", terminal: "term_1", worktree: "/w/fix-readme", branch: "fix-readme", agent: "claude", model: "claude-sonnet-5-5", owner: "tester" });
  });

  it("finds the agent terminal in the launch.outcome.handle result shape", async () => {
    const f = fakeOrca({
      "worktree create": { stdout: { ok: true, result: { worktree: { path: "/w/add-x", git: { branch: "refs/heads/me/add-x" } }, launch: { outcome: { kind: "terminal", handle: "term_e621", paneKey: "p" } } } } },
    });
    const r = await fakeTools(f).call("orca_worktree_create", { repo: join(f.devRoot, "repo"), name: "add-x", agent: "claude", prompt: "p" });
    expect(r.data.worker).toMatchObject({ key: "term:term_e621", terminal: "term_e621", worktree: "/w/add-x" });
  });

  it("without a terminal handle the start is an error that says the agent did start", async () => {
    const f = fakeOrca({ "worktree create": { stdout: { ok: true, result: { worktree: { path: "/w/x" } } } } });
    const r = await fakeTools(f).call("orca_worktree_create", { repo: join(f.devRoot, "repo"), name: "x", agent: "claude", prompt: "p" });
    expect(r.isError).toBe(true);
    expect(r.data.worker).toBeUndefined();
    expect(r.text).toMatch(/Do not start it again/);
  });

  it("rejects repos outside the roots before running orca", async () => {
    const f = fakeOrca({});
    const { call } = fakeTools(f);
    const r = await call("orca_worktree_create", { repo: "/etc", name: "x", agent: "claude", prompt: "p" });
    expect(r).toMatchObject({ isError: true, state: "error" });
    expect(r.text).toMatch(/outside the allowed roots/);
    expect((await call("orca_repo_add", { path: join(f.devRoot, "..") })).isError).toBe(true);
    expect(() => f.calls()).toThrow();
  });

  it("falls back to worktree create when orchestration is disabled", async () => {
    const f = fakeOrca({ "worktree create": { stdout: { ok: true, result: { agentTerminalHandle: "term_9" } } } });
    const { call } = fakeTools(f, { orchestration: false });
    const started = await call("orca_worker_start", { repo: join(f.devRoot, "repo"), name: "w1", agent: "opencode", spec: "do it" });
    expect(started.data.worker).toMatchObject({ key: "term:term_9" });
    expect((await call("orca_run_create", { objective: "x" })).isError).toBe(true);
    expect(f.calls().map((c) => c.argv.slice(0, 2).join(" "))).toEqual(["worktree create"]);
  });

  it("uses orchestration worker-start when available and reads the concise receipt", async () => {
    const f = fakeOrca({ "orchestration worker-start": { stdout: { ok: true, result: { dispatchId: "disp_1", taskId: "task_1", runId: "run_1", state: "ready", terminal: "term_4", workspace: "repo1::/w/x" } } } });
    const r = await fakeTools(f, { orchestration: true }).call("orca_worker_start", { repo: join(f.devRoot, "repo"), name: "x", agent: "claude", spec: "s", model: "claude-sonnet-5-5", effort: "high" });
    expect(f.calls()[0]!.argv).toEqual([
      "orchestration",
      "worker-start",
      "--spec=s",
      "--worktree=new-top-level",
      `--repo=path:${join(f.devRoot, "repo")}`,
      "--name=x",
      "--agent=claude",
      "--comment=orca-mcp:tester",
      "--model=claude-sonnet-5-5",
      "--effort=high",
      "--json",
    ]);
    expect(r.data.worker).toMatchObject({ key: "dispatch:disp_1", dispatch: "disp_1", task: "task_1", run: "run_1", terminal: "term_4", worktree: "/w/x", owner: "tester" });
  });

  it("stop and rm report what they released", async () => {
    const f = fakeOrca({});
    const { call } = fakeTools(f);
    const stopped = await call("orca_worker_stop", { terminal: "term_1" });
    expect(stopped).toMatchObject({ state: "stopped", data: { stopped: { key: "term:term_1" } } });
    const wt = join(f.devRoot, "repo");
    expect((await call("orca_worktree_rm", { worktree: wt })).data.stopped).toEqual({ worktree: wt });
    expect(f.calls().at(-1)!.argv).toEqual(["worktree", "rm", `--worktree=path:${wt}`, "--json"]);
  });

  it("allows removing an Orca worktree outside the roots only when its repo is inside them", async () => {
    const f = fakeOrca({
      "worktree list": { stdout: { ok: true, result: { worktrees: [{ path: "/elsewhere/wt-a", repoId: "REPO" }, { path: "/elsewhere/wt-b", repoId: "OTHER" }] } } },
    });
    f.setReplies({ "repo list": { stdout: { ok: true, result: { repos: [{ id: "REPO", path: join(f.devRoot, "repo") }, { id: "OTHER", path: "/etc" }] } } } });
    const { call } = fakeTools(f);
    expect((await call("orca_worktree_rm", { worktree: "/elsewhere/wt-a" })).isError).toBe(false);
    expect((await call("orca_worktree_rm", { worktree: "/elsewhere/wt-b" })).isError).toBe(true);
    expect(f.calls().filter((c) => c.argv[1] === "rm").map((c) => c.argv[2])).toEqual(["--worktree=path:/elsewhere/wt-a"]);
  });

  it("orca_worktrees filters by repo on a path boundary and by owner", async () => {
    const f = fakeOrca({});
    const foo = join(f.devRoot, "foo");
    const worktrees = [
      { path: foo, branch: "main", comment: "" },
      { path: join(foo, "wt"), branch: "refs/heads/wt", comment: "orca-mcp:tester", agents: [{ agentType: "claude", state: "working" }] },
      { path: join(f.devRoot, "foobar"), branch: "x", comment: "orca-mcp:someone-else" },
    ];
    f.setReplies({ "worktree ps": { stdout: { ok: true, result: { worktrees } } } });
    const { call } = fakeTools(f);
    const r = await call("orca_worktrees", { repo: foo });
    expect(r.summary).toBe("2 worktrees, 1 live agent.");
    expect(r.text).toContain(`- ${foo} [main]`);
    expect(r.text).toContain(`- ${join(foo, "wt")} [wt]  owner=tester agents: claude:working`);
    expect(r.text).not.toContain("foobar");
    const mine = await call("orca_worktrees", { mine: true });
    expect((mine.data.worktrees as unknown[]).length).toBe(1);
  });

  it("returns terminal output as text with the next cursor", async () => {
    const f = fakeOrca({ "terminal read": { stdout: { ok: true, result: { tail: ["line 1", "line 2"], nextCursor: 42 } } } });
    const r = await fakeTools(f).call("orca_terminal_read", { terminal: "term_1", cursor: 10 });
    expect(r.text).toBe("ok: Read 2 lines from terminal term_1, next cursor 42.\nline 1\nline 2");
    expect(r.data.nextCursor).toBe("42");
    expect(f.calls()[0]!.argv).toEqual(["terminal", "read", "--terminal=term_1", "--cursor=10", "--json"]);
  });

  it("orca_status reports version and capabilities in one line", async () => {
    const f = fakeOrca({ status: { stdout: { ok: true, result: { app: { running: true }, runtime: { state: "ready", reachable: true, appVersion: "1.4.250", capabilities: ["orchestration.contract.v1"] } } } } });
    const r = await fakeTools(f, { orchestration: true }).call("orca_status", {});
    expect(r.text).toBe("ok: Orca app running, runtime ready, version 1.4.250, orchestration on, external coordinator not supported.");
  });
});

describe("ownership tag", () => {
  it("appends the tag to the caller's note and matches only a whole token", async () => {
    expect(ownerComment("tester", "review by Friday")).toBe("review by Friday orca-mcp:tester");
    expect(ownerComment("tester")).toBe("orca-mcp:tester");
    expect(ownerOf("review by Friday orca-mcp:tester")).toBe("tester");
    expect(ownerOf("orca-mcp:tester extra")).toBe("tester");
    expect(ownerOf("xorca-mcp:tester")).toBeUndefined();
    expect(ownerOf("orca-mcp:tester,other")).toBeUndefined();
    const f = fakeOrca({ "worktree create": { stdout: { ok: true, result: { agentTerminalHandle: "term_1" } } } });
    await fakeTools(f).call("orca_worktree_create", { repo: join(f.devRoot, "repo"), name: "x", agent: "claude", prompt: "p", comment: "review by Friday" });
    expect(f.calls()[0]!.argv).toContain("--comment=review by Friday orca-mcp:tester");
  });

  it("without ORCA_MCP_CLIENT two server instances of one client get different tags", async () => {
    const tagOf = async () => {
      const argv: string[][] = [];
      const list = buildTools({
        orchestration: async () => false,
        capabilities: async () => new Set(),
        env: { HOME: "/nowhere", ORCA_MCP_ROOTS: "/" },
        client: () => "claude-code",
        run: async (args) => (argv.push(args), { ok: true, result: { agentTerminalHandle: "term_1" } }),
      });
      await (list.find((t) => t.name === "orca_worktree_create")!.handler as (a: unknown) => Promise<ToolResult>)({ repo: "/tmp", name: "x", prompt: "p" });
      return argv[0]!.find((a) => a.startsWith("--comment="))!;
    };
    const [a, b] = [await tagOf(), await tagOf()];
    expect(a).toMatch(/^--comment=orca-mcp:claude-code-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
  });
});

describe("external coordinator (paired environment) over the fake binary", () => {
  const paired = { orchestration: true, caps: [EXTERNAL_COORDINATOR_CAPABILITY], envExtra: { ORCA_MCP_ENVIRONMENT: "this-mac", ORCA_ENVIRONMENT: "other", ORCA_PAIRING_CODE: "orca://pair?code=x" } };

  it("run-create binds the Run with --external and every coordinator call names the saved environment", async () => {
    const f = fakeOrca({
      "orchestration run-create": { stdout: { ok: true, result: { run: { id: "run_7", objective: "ship it", consumer_generation: 1 } } } },
      "orchestration task-create": { stdout: { ok: true, result: { task: { id: "task_1" } } } },
      "worktree create": { stdout: { ok: true, result: { worktree: { id: "repo1::/w/w", path: "/w/w", branch: "w" } } } },
      "orchestration worker-start": { stdout: { ok: true, result: { dispatchId: "disp_1", runId: "run_7", state: "ready" } } },
      "orchestration check": { stdout: { ok: true, result: { messages: [{ id: "m1", type: "worker_done", from: "disp_1" }] } } },
    });
    const { call } = fakeTools(f, paired);
    const created = await call("orca_run_create", { objective: "ship it" });
    expect(created).toMatchObject({ state: "ok", summary: "Run run_7 created (coordinator environment:this-mac).", data: { runId: "run_7", coordinator: "environment:this-mac" } });
    await call("orca_task_create", { spec: "t", run: "run_7" });
    const started = await call("orca_worker_start", { repo: join(f.devRoot, "repo"), name: "w", agent: "claude", spec: "s", run: "run_7" });
    expect(started.data.worker).toMatchObject({ dispatch: "disp_1", run: "run_7", worktree: "/w/w", owner: "tester" });
    expect(await call("orca_wait", { run: "run_7", timeoutMs: 60_000 })).toMatchObject({ state: "done" });
    await call("orca_send", { to: "dispatch:disp_1", body: "rebase first" });
    await call("orca_worktrees", {});
    const calls = f.calls();
    const argvOf = (cmd: string) => calls.find((c) => c.argv.slice(0, 2).join(" ") === cmd)!.argv;
    expect(argvOf("orchestration run-create")).toEqual(["orchestration", "run-create", "--objective=ship it", "--external", "--environment=this-mac", "--json"]);
    // No workspace of its own: the worktree (with the owner tag) first, then the worker into it, without creation flags.
    expect(argvOf("worktree create")).toEqual(["worktree", "create", "--name=w", `--repo=path:${join(f.devRoot, "repo")}`, "--no-parent", "--comment=orca-mcp:tester", "--environment=this-mac", "--json"]);
    expect(argvOf("orchestration worker-start")).toEqual(["orchestration", "worker-start", "--spec=s", "--worktree=id:repo1::/w/w", "--agent=claude", "--run=run_7", "--environment=this-mac", "--json"]);
    for (const cmd of ["orchestration task-create", "orchestration check", "orchestration send"]) expect(argvOf(cmd).at(-2)).toBe("--environment=this-mac");
    expect(argvOf("worktree ps")).toEqual(["worktree", "ps", "--environment=this-mac", "--json"]);
    // The environment travels only on argv: none of the parent's environment selectors reach the child.
    for (const c of calls) for (const k of ["ORCA_MCP_ENVIRONMENT", "ORCA_ENVIRONMENT", "ORCA_PAIRING_CODE"]) expect(c.env).not.toContain(k);
  });

  it("names the worktree by path when Orca gives no id, and a refused start says to create a Run and keeps the worktree", async () => {
    const f = fakeOrca({
      "worktree create": { stdout: { ok: true, result: { path: "/w/x" } } },
      "orchestration worker-start": { stdout: { ok: false, error: { code: "run_required", message: "No Run is bound to this external coordinator." } }, exit: 1 },
    });
    const r = await fakeTools(f, paired).call("orca_worker_start", { repo: join(f.devRoot, "repo"), name: "x", agent: "codex", spec: "s" });
    expect(f.calls()[1]!.argv).toEqual(["orchestration", "worker-start", "--spec=s", "--worktree=path:/w/x", "--agent=codex", "--environment=this-mac", "--json"]);
    expect(r).toMatchObject({ isError: true, data: { code: "run_required", worktree: "/w/x" } });
    expect(r.summary).toMatch(/Create one with orca_run_create first\. The worktree \/w\/x was created for it and is kept\.$/);
  });

  it("a terminal taking the Run over (consumer_fenced) ends a pending wait as state fenced, not an error", async () => {
    const fence: OrcaResult = { ok: false, error: "orca error: This external coordinator is no longer bound to Run run_5.", code: "consumer_fenced" };
    const o = scripted({ "orchestration run-create": [{ ok: true, result: { run: { id: "run_5" } } }], "orchestration check": [fence] }, { orchestration: true, caps: [EXTERNAL_COORDINATOR_CAPABILITY], envExtra: { ORCA_MCP_ENVIRONMENT: "this-mac" } });
    await o.call("orca_run_create", { objective: "x" });
    const waited = await o.call("orca_wait", { timeoutMs: 600_000 });
    expect(waited).toMatchObject({ state: "fenced", isError: false, data: { code: "consumer_fenced", runId: "run_5" } });
    expect(waited.summary).toBe("Run run_5 was taken over by another coordinator (consumer_fenced); this server no longer coordinates it.");
    // The Run is no longer this server's: a bare wait does not go back to its mailbox.
    const checks = o.kinds().filter((k) => k === "orchestration check").length;
    await o.call("orca_wait", { timeoutMs: 1000 });
    expect(o.kinds().filter((k) => k === "orchestration check")).toHaveLength(checks);
    expect(await o.call("orca_check", { run: "run_5", timeoutMs: 1000 })).toMatchObject({ state: "fenced", isError: false });
  });

  it("every orca call of every tool, probes included, names the saved environment", async () => {
    const f = fakeOrca({
      status: { stdout: { ok: true, result: { app: { running: true }, runtime: { state: "ready", reachable: true, capabilities: [EXTERNAL_COORDINATOR_CAPABILITY] } } } },
      "worktree create": { stdout: { ok: true, result: { agentTerminalHandle: "term_1", worktree: { id: "repo1::/w/w", path: "/w/w" } } } },
      "orchestration check": { stdout: { ok: true, result: { messages: [{ id: "m1", type: "worker_done", from: "disp_1" }] } } },
    });
    const env = { ...f.env, ORCA_MCP_ENVIRONMENT: "this-mac" };
    let t = 1_000_000;
    // The real capability and orchestration probes, so their calls are checked too.
    const list = buildTools({ env, run: (args, o) => runOrca(args, { ...o, bin: f.bin, env }), now: () => t, sleep: async (ms) => void (t += ms) });
    const repo = join(f.devRoot, "repo");
    const calls: [string, Record<string, unknown>][] = [
      ["orca_status", {}],
      ["orca_repos", {}],
      ["orca_repo_add", { path: repo }],
      ["orca_worktrees", {}],
      ["orca_worktree_create", { repo, name: "a", agent: "claude", prompt: "p" }],
      ["orca_terminal_read", { terminal: "term_1" }],
      ["orca_terminal_send", { terminal: "term_1", text: "hi", enter: true }],
      ["orca_terminal_wait", { terminal: "term_1", for: "done", timeoutMs: 1000 }],
      ["orca_terminal_wait", { terminal: "term_1", for: "exit", timeoutMs: 1000 }],
      ["orca_agent_status", { dispatch: "disp_1" }],
      ["orca_run_create", { objective: "o" }],
      ["orca_task_create", { spec: "t", run: "run_1" }],
      ["orca_worker_start", { repo, name: "w", spec: "s", run: "run_1" }],
      ["orca_wait", { run: "run_1", terminal: "term_1", timeoutMs: 1000 }],
      ["orca_wait", { worktree: repo, timeoutMs: 1000 }],
      ["orca_check", { run: "run_1", peek: true }],
      ["orca_check", { terminal: "term_1", timeoutMs: 1000 }],
      ["orca_worker_read", { dispatch: "disp_1" }],
      ["orca_worker_read", { terminal: "term_1" }],
      ["orca_worker_stop", { dispatch: "disp_1" }],
      ["orca_worker_stop", { terminal: "term_1" }],
      ["orca_send", { to: "dispatch:disp_1", body: "b" }],
      ["orca_send", { terminal: "term_1", body: "b" }],
      ["orca_search", { query: "q" }],
      ["orca_worktree_rm", { worktree: "/elsewhere/x" }],
      ["orca_worktree_rm", { worktree: repo }],
    ];
    // A new tool must be added here, so it cannot escape the check.
    expect(new Set(calls.map(([n]) => n))).toEqual(new Set(list.map((x) => x.name)));
    for (const [n, args] of calls) await (list.find((x) => x.name === n)!.handler as (a: unknown) => Promise<ToolResult>)(args);
    const spawned = f.calls().map((c) => c.argv);
    expect(spawned.filter((a) => !a.includes("--environment=this-mac"))).toEqual([]);
    const kinds = new Set(spawned.map((a) => a.slice(0, 2).join(" ")));
    for (const k of ["orchestration run-list", "worktree ps", "terminal list", "terminal show", "terminal wait", "orchestration worker-list", "orchestration worker-show", "orchestration worker-read", "orchestration worker-stop", "terminal close", "worktree list", "repo list", "worktree rm", "search --query=q"]) expect(kinds).toContain(k);
  });

  it("an unreachable environment fails every tool closed, rereads it only after 30 s, and never falls back to local Orca", async () => {
    const o = scripted(
      { "status --environment=this-mac": [{ ok: false, error: "orca error: Unknown Orca server in --environment this-mac" }, { ok: true, result: { runtime: { capabilities: [EXTERNAL_COORDINATOR_CAPABILITY] } } }] },
      { orchestration: true, envExtra: { ORCA_MCP_ENVIRONMENT: "this-mac" }, deps: { capabilities: undefined } },
    );
    for (const n of ["orca_status", "orca_worktrees", "orca_agent_status", "orca_run_create", "orca_wait"]) {
      const r = await o.call(n, n === "orca_run_create" ? { objective: "x" } : {});
      expect(r).toMatchObject({ isError: true, data: { code: "environment_unavailable", environment: "this-mac" } });
      expect(r.summary).toBe("Orca environment this-mac (ORCA_MCP_ENVIRONMENT) cannot be reached: orca error: Unknown Orca server in --environment this-mac");
    }
    expect(o.kinds()).toEqual(["status --environment=this-mac"]);
    o.at(1_000_000 + 30_000);
    expect((await o.call("orca_worktrees", {})).isError).toBe(false);
    expect(o.calls.slice(1)).toEqual([["status", "--environment=this-mac"], ["worktree", "ps", "--environment=this-mac"]]);
  });

  it("a mode read from a successful probe holds for the session", async () => {
    let caps: string[] = [];
    const o = scripted({ "orchestration run-create": [{ ok: true, result: { run: { id: "run_9" } } }] }, { orchestration: true, envExtra: { ORCA_MCP_ENVIRONMENT: "this-mac" }, deps: { capabilities: async () => new Set(caps) } });
    expect((await o.call("orca_run_create", { objective: "a" })).data.coordinator).toBe("legacy");
    caps = [EXTERNAL_COORDINATOR_CAPABILITY];
    expect((await o.call("orca_run_create", { objective: "b" })).data.coordinator).toBe("legacy");
    await o.call("orca_worktrees", {});
    expect(o.calls.flat().some((a) => a.startsWith("--environment") || a === "--external")).toBe(false);
  });

  it("orca_status says which environment coordinates, and the capability probe asks that environment", async () => {
    const f = fakeOrca({ status: { stdout: { ok: true, result: { app: { running: true }, runtime: { state: "ready", reachable: true, appVersion: "1.4.260", capabilities: [EXTERNAL_COORDINATOR_CAPABILITY] } } } } });
    const r = await fakeTools(f, paired).call("orca_status", {});
    expect(r.summary).toBe("Orca app running, runtime ready, version 1.4.260, orchestration on, external coordinator on (environment this-mac).");
    expect(r.data).toMatchObject({ externalCoordinator: true, environment: "this-mac" });
    const seen: string[][] = [];
    const probe = capabilityProbe(async (args) => (seen.push(args), { ok: true, result: { runtime: { capabilities: [EXTERNAL_COORDINATOR_CAPABILITY] } } }), ["--environment=this-mac"]);
    expect((await probe.get()).has(EXTERNAL_COORDINATOR_CAPABILITY)).toBe(true);
    expect(seen).toEqual([["status", "--environment=this-mac"]]);
  });
});

describe("embedding seam", () => {
  it("onToolResult sees every tool's name, args and result and may replace the result", async () => {
    const seen: [string, unknown, ToolResult][] = [];
    const list = buildTools({
      orchestration: async () => false,
      capabilities: async () => new Set(),
      env: { HOME: "/nowhere", ORCA_MCP_ROOTS: "/nowhere" },
      run: async () => ({ ok: true, result: { tail: "x" } }),
      onToolResult: (name, args, result) => {
        seen.push([name, args, result]);
        if (name === "orca_terminal_read") return { ...result, content: [{ type: "text", text: "marker\n" + result.content[0]!.text }] };
      },
    });
    const read = await (list.find((t) => t.name === "orca_terminal_read")!.handler as (a: unknown) => Promise<ToolResult>)({ terminal: "term_1" });
    expect(read.content[0]!.text.startsWith("marker\n")).toBe(true);
    const sent = await (list.find((t) => t.name === "orca_terminal_send")!.handler as (a: unknown) => Promise<ToolResult>)({ terminal: "term_1", text: "hi" });
    expect(sent.content[0]!.text).toBe("ok: Sent to term_1.");
    expect(seen.map(([n, a]) => [n, a])).toEqual([
      ["orca_terminal_read", { terminal: "term_1" }],
      ["orca_terminal_send", { terminal: "term_1", text: "hi" }],
    ]);
    // Called directly, a handler still validates and fills the schema's defaults.
    const bad = await (list.find((t) => t.name === "orca_terminal_read")!.handler as (a: unknown) => Promise<ToolResult>)({ terminal: "--json" });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.content[0]!.text).toMatch(/^error: invalid arguments for orca_terminal_read: terminal not a valid Orca handle/);
  });
});

const shown: OrcaResult = { ok: true, result: { terminal: { handle: "term_1", tabId: "tab", leafId: "leaf" } } };
const terms: OrcaResult = { ok: true, result: { terminals: [{ handle: "term_1", tabId: "tab", leafId: "leaf", worktreeId: "r::/w/x" }, { handle: "term_2", tabId: "t2", leafId: "l2" }] } };
// The owner's own agent in another pane: done, with a message that must never reach a result.
const other = { path: "/other", comment: "", agents: [{ paneKey: "x:y", state: "done", stateStartedAt: 1_000_000, lastAssistantMessage: "OWNER-PRIVATE" }] };
const pane = (state: string, stateStartedAt = 1_000_000, extra: Record<string, unknown> = {}): OrcaResult => ({
  ok: true,
  result: { worktrees: [other, { path: "/w/x", worktreeId: "r::/w/x", comment: "orca-mcp:tester", agents: [{ paneKey: "tab:leaf", agentType: "claude", state, stateStartedAt, ...extra }] }] },
});

describe("orca_terminal_wait (hook state)", () => {
  it("returns as soon as the agent's hook state is done, with its last message", async () => {
    const o = scripted({ "terminal show": [shown], "worktree ps": [pane("working"), pane("working"), pane("done", 1_010_000, { lastAssistantMessage: "Added multiply, 6 tests pass." })] });
    const r = await o.call("orca_terminal_wait", { terminal: "term_1", timeoutMs: 600_000 });
    expect(r).toMatchObject({ isError: false, state: "done", summary: "Agent done: Added multiply, 6 tests pass." });
    expect(r.data.worker).toMatchObject({ terminal: "term_1", state: "done", lastAssistantMessage: "Added multiply, 6 tests pass.", owner: "tester" });
    expect(r.text).not.toContain("OWNER-PRIVATE");
    expect(o.kinds()).toEqual(["terminal show", "worktree ps", "worktree ps", "worktree ps"]);
  });

  it("orca_send to a terminal counts as a send, and a done without a timestamp after it needs the agent seen working", async () => {
    const row = (state: string, msg?: string): OrcaResult => ({ ok: true, result: { worktrees: [{ agents: [{ paneKey: "tab:leaf", state, ...(msg ? { lastAssistantMessage: msg } : {}) }] }] } });
    const o = scripted({ "terminal show": [shown], "worktree ps": [row("done", "a"), row("working"), row("done", "b")] });
    await o.call("orca_send", { terminal: "term_1", body: "one more thing" });
    const r = await o.call("orca_terminal_wait", { terminal: "term_1", timeoutMs: 600_000 });
    expect(r.state).toBe("done");
    expect(o.kinds().filter((k) => k === "worktree ps")).toHaveLength(3);
  });

  it("says Orca is not answering after repeated failed reads, instead of waiting out the timeout", async () => {
    const o = scripted({ "terminal show": [shown], "worktree ps": [pane("working"), { ok: false, error: "orca runtime not running" }] });
    const r = await o.call("orca_terminal_wait", { terminal: "term_1", timeoutMs: 600_000 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Orca is not answering.*orca runtime not running/);
    expect(o.kinds().filter((k) => k === "worktree ps")).toHaveLength(4);
  });

  it("a terminal Orca does not know is an error", async () => {
    const o = scripted({ "terminal show": [{ ok: false, error: "terminal not found" }] });
    expect(await o.call("orca_terminal_wait", { terminal: "term_1", timeoutMs: 600_000 })).toMatchObject({ isError: true, summary: "terminal not found" });
  });

  it("no fallback while a slow agent boots: a pane with no hook state for under two minutes is still waited on", async () => {
    const o = scripted({ "terminal show": [shown], "worktree ps": [...Array.from({ length: 20 }, () => ({ ok: true, result: { worktrees: [] } }) as OrcaResult), pane("done", 1_000_000, { lastAssistantMessage: "ok" })] });
    expect((await o.call("orca_terminal_wait", { terminal: "term_1", timeoutMs: 600_000 })).state).toBe("done");
    expect(o.kinds()).not.toContain("terminal wait");
  });

  it("a messageless done right after launch is skipped; the same done on the next read counts", async () => {
    const o = scripted({ "terminal show": [shown], "worktree ps": [pane("done", 1_000_000), pane("working", 1_004_000), pane("done", 1_010_000), pane("done", 1_010_000)] });
    expect((await o.call("orca_terminal_wait", { terminal: "term_1", timeoutMs: 600_000 })).state).toBe("done");
    expect(o.kinds().filter((k) => k === "worktree ps")).toHaveLength(4);
  });

  it("a done state from before the last message sent to the agent does not count", async () => {
    const o = scripted({ "terminal show": [shown], "worktree ps": [pane("done", 900_000, { lastAssistantMessage: "old" }), pane("working", 1_000_500), pane("done", 1_006_000, { lastAssistantMessage: "new" })] });
    o.at(1_000_000);
    await o.call("orca_terminal_send", { terminal: "term_1", text: "also add a test", enter: true });
    const r = await o.call("orca_terminal_wait", { terminal: "term_1", timeoutMs: 600_000 });
    expect(r.summary).toBe("Agent done: new");
    expect(o.kinds().filter((k) => k === "worktree ps")).toHaveLength(3);
  });

  it("a timeout is a normal result saying it still runs, not an error", async () => {
    const o = scripted({ "terminal show": [shown], "worktree ps": [pane("working", 1_000_000, { toolName: "Bash" })] });
    const r = await o.call("orca_terminal_wait", { terminal: "term_1", timeoutMs: 20_000 });
    expect(r).toMatchObject({ isError: false, state: "working", summary: "Still running after 20 s, last tool Bash." });
  });

  it("falls back to tui-idle when no hook state shows up for the agent", async () => {
    const o = scripted({ "terminal show": [shown], "worktree ps": [{ ok: true, result: { worktrees: [] } }], "terminal wait": [{ ok: true, result: { satisfied: true } }] });
    const r = await o.call("orca_terminal_wait", { terminal: "term_1", timeoutMs: 600_000 });
    expect(r).toMatchObject({ isError: false, state: "idle", data: { via: "tui-idle" } });
    const wait = o.calls.find((c) => c[0] === "terminal" && c[1] === "wait")!;
    expect(wait.slice(0, 4)).toEqual(["terminal", "wait", "--terminal=term_1", "--for=tui-idle"]);
    expect(Number(wait[4]!.split("=")[1])).toBeLessThan(600_000);
  });

  it("tui-idle and exit stay available as explicit conditions", async () => {
    const o = scripted({ "terminal wait": [{ ok: true, result: {} }] });
    await o.call("orca_terminal_wait", { terminal: "term_1", for: "exit", timeoutMs: 5000 });
    expect(o.calls[0]).toEqual(["terminal", "wait", "--terminal=term_1", "--for=exit", "--timeout-ms=5000"]);
  });

  it("orca_check on a terminal waits for the hook state even when orchestration is on", async () => {
    const o = scripted({ "terminal show": [shown], "worktree ps": [pane("done", 1_000_000, { lastAssistantMessage: "ok" })] }, { orchestration: true });
    expect((await o.call("orca_check", { terminal: "term_1", timeoutMs: 300_000 })).state).toBe("done");
    expect(o.kinds().some((k) => k.startsWith("orchestration"))).toBe(false);
    await o.call("orca_check", { run: "run_1", terminal: "term_1", timeoutMs: 5000 });
    expect(o.calls.at(-1)).toEqual(["orchestration", "check", "--peek", "--run=run_1", "--terminal=term_1", "--wait", "--timeout-ms=5000"]);
  });

  it("orca_check on a run never takes mail: every run check passes --peek", async () => {
    const o = scripted({ "orchestration check": [{ ok: true, result: { messages: [{ id: "m1", type: "worker_done", from: "disp_1" }] } }] }, { orchestration: true });
    expect((await o.call("orca_check", { run: "run_1", timeoutMs: 5000 })).state).toBe("done");
    await o.call("orca_check", { run: "run_1", peek: true, timeoutMs: 5000 });
    await o.call("orca_check", { run: "run_1", peek: false, timeoutMs: 5000 });
    expect(o.calls).toHaveLength(3);
    expect(o.calls.every((c) => c.includes("--peek"))).toBe(true);
    expect(o.calls[1]).toEqual(["orchestration", "check", "--peek", "--run=run_1"]);
  });
});

describe("orca_wait", () => {
  it("done via hook state: with no target it waits on every worker this client started, and reports each finish once", async () => {
    const o = scripted({ "terminal list": [terms], "worktree ps": [pane("working"), pane("done", 1_010_000, { lastAssistantMessage: "Refactor finished." })] });
    const r = await o.call("orca_wait", { timeoutMs: 600_000 });
    expect(r).toMatchObject({ isError: false, state: "done", data: { via: "hook" } });
    expect(r.summary).toMatch(/^x \(claude\) done for 0s: Refactor finished\.$/);
    expect(r.data.worker).toMatchObject({ terminal: "term_1", worktree: "/w/x", state: "done", owner: "tester", lastAssistantMessage: "Refactor finished." });
    // The other pane is done too, but it is not this client's worker.
    expect(r.text).not.toContain("OWNER-PRIVATE");
    const again = await o.call("orca_wait", { timeoutMs: 600_000 });
    expect(again).toMatchObject({ state: "idle", summary: "Nothing new in the workers of tester: all 1 agent already reported." });
  });

  it("blocked via waiting: an agent parked on a permission prompt returns at once with what it waits on", async () => {
    const o = scripted({ "terminal show": [shown], "worktree ps": [pane("working"), pane("waiting", 1_005_000, { toolName: "Bash", toolInput: "rm -rf build" })] });
    const r = await o.call("orca_wait", { terminal: "term_1", timeoutMs: 600_000 });
    expect(r).toMatchObject({ isError: false, state: "waiting", data: { via: "hook" } });
    expect(r.data.worker).toMatchObject({ state: "waiting", blockedOn: "Bash: rm -rf build" });
    expect(r.summary).toBe("Agent is waiting (waiting, on Bash: rm -rf build).");
  });

  it("done via worker_done: a run waits on its mailbox with --peek, never taking mail, and each message is returned once", async () => {
    const done = (id: string, from: string): OrcaResult => ({ ok: true, result: { messages: [{ id, type: "worker_done", from, subject: `Task ${from} done`, body: "All tests pass." }] } });
    const both: OrcaResult = { ok: true, result: { messages: [{ id: "m1", type: "worker_done", from: "disp_1", subject: "Task disp_1 done" }, { id: "m2", type: "escalation", from: "disp_2", subject: "Need a decision", body: "Which DB?" }] } };
    const o = scripted({ "orchestration check": [done("m1", "disp_1"), both, both] }, { orchestration: true });
    const r = await o.call("orca_wait", { run: "run_1", timeoutMs: 300_000 });
    expect(r).toMatchObject({ state: "done", summary: "Worker disp_1 done: Task disp_1 done", data: { via: "mail", runId: "run_1", event: { type: "worker_done", messageId: "m1", dispatchId: "disp_1" } } });
    const checks = () => o.calls.filter((c) => c[1] === "check");
    expect(checks()[0]).toEqual(["orchestration", "check", "--run=run_1", "--peek", "--types=worker_done,escalation", "--wait", "--timeout-ms=300000"]);
    const next = await o.call("orca_wait", { run: "run_1", timeoutMs: 300_000 });
    expect(next).toMatchObject({ state: "blocked", summary: "Worker disp_2 escalated: Need a decision", data: { event: { messageId: "m2" } } });
    expect(checks().every((c) => c.includes("--peek"))).toBe(true);
  });

  it("a run whose unread mail was all returned already polls instead of spinning, until the timeout", async () => {
    const seen: OrcaResult = { ok: true, result: { messages: [{ id: "m1", type: "worker_done", from: "disp_1" }] } };
    const o = scripted({ "orchestration check": [seen] }, { orchestration: true });
    await o.call("orca_wait", { run: "run_1", timeoutMs: 300_000 });
    const r = await o.call("orca_wait", { run: "run_1", timeoutMs: 20_000 });
    expect(r).toMatchObject({ state: "working", data: { via: "mail" } });
    // The second wait's first check used --wait; the following polls do not (they would return at once anyway).
    const checks = o.calls.filter((c) => c[1] === "check");
    expect(checks.length).toBeLessThan(10);
    expect(checks.at(-1)).not.toContain("--wait");
  });

  it("a dispatch waits on its run's mail from that dispatch; an unreadable mailbox falls back to the worker's terminal", async () => {
    const o = scripted(
      {
        "orchestration worker-show": [{ ok: true, result: { dispatchId: "disp_1", runId: "run_1", terminal: "term_1", state: "ready" } }],
        "orchestration check": [{ ok: false, error: "orca error: not the coordinator", code: "stable_pane_required" }],
        "terminal show": [shown],
        "terminal list": [terms],
        "worktree ps": [pane("done", 1_000_000, { lastAssistantMessage: "Shipped." })],
      },
      { orchestration: true },
    );
    const r = await o.call("orca_wait", { dispatch: "disp_1", timeoutMs: 300_000 });
    expect(r).toMatchObject({ state: "done", data: { via: "hook", worker: { terminal: "term_1" } } });
    expect(r.text).toContain("Run mailbox unreadable (stable_pane_required); waited on hook state instead.");
    expect(o.kinds()[0]).toBe("orchestration worker-show");
    expect(o.kinds()).toContain("orchestration check");
  });

  it("a dispatch with no terminal or worktree and an unreadable mailbox is unknown, never another worker's event", async () => {
    const o = scripted(
      {
        "orchestration worker-show": [{ ok: true, result: { dispatchId: "disp_1", runId: "run_1", state: "ready" } }],
        "orchestration check": [{ ok: false, error: "orca error: not the coordinator", code: "stable_pane_required" }],
        "terminal list": [terms],
        // This client's other worker is done; it must not be reported as disp_1.
        "worktree ps": [pane("done", 1_000_000, { lastAssistantMessage: "Other work." })],
      },
      { orchestration: true },
    );
    const r = await o.call("orca_wait", { dispatch: "disp_1", timeoutMs: 300_000 });
    expect(r).toMatchObject({ isError: false, state: "unknown", data: { dispatchId: "disp_1" } });
    expect(r.summary).toMatch(/^Cannot wait on dispatch disp_1: its Run mailbox is unreadable \(stable_pane_required\)/);
    expect(r.text).not.toContain("Other work.");
  });

  it("a dispatch with only a worktree is scoped to that worktree when its mailbox is unreadable", async () => {
    const fleet: OrcaResult = { ok: true, result: { worktrees: [
      { path: "/w/x", worktreeId: "r::/w/x", comment: "orca-mcp:tester", agents: [{ paneKey: "tab:leaf", agentType: "claude", state: "done", stateStartedAt: 1_000_000, lastAssistantMessage: "Other work." }] },
      { path: "/w/y", worktreeId: "r::/w/y", comment: "orca-mcp:tester", agents: [{ paneKey: "t2:l2", agentType: "codex", state: "waiting", stateStartedAt: 1_000_000, toolName: "Bash" }] },
    ] } };
    const o = scripted(
      {
        "orchestration worker-show": [{ ok: true, result: { dispatchId: "disp_2", runId: "run_1", workspace: "r::/w/y" } }],
        "orchestration check": [{ ok: false, error: "orca error: not the coordinator", code: "stable_pane_required" }],
        "terminal list": [terms],
        "worktree ps": [fleet],
      },
      { orchestration: true },
    );
    const r = await o.call("orca_wait", { dispatch: "disp_2", timeoutMs: 300_000 });
    expect(r).toMatchObject({ state: "waiting", data: { via: "hook", worker: { worktree: "/w/y", terminal: "term_2" } } });
    expect(r.text).not.toContain("Other work.");
  });

  it("inside a Run, a worker parked on a prompt returns waiting before the timeout though it never mails", async () => {
    const o = scripted(
      {
        "orchestration worker-list": [{ ok: true, result: { workers: [{ dispatchId: "disp_1", workspace: "r::/w/x" }] } }],
        "orchestration check": [{ ok: true, result: { messages: [], timedOut: true } }],
        "terminal list": [terms],
        "worktree ps": [pane("working"), pane("waiting", 1_005_000, { toolName: "Bash", toolInput: "git push" })],
      },
      { orchestration: true },
    );
    const r = await o.call("orca_wait", { run: "run_1", timeoutMs: 300_000 });
    expect(r).toMatchObject({ isError: false, state: "waiting", data: { via: "hook", worker: { worktree: "/w/x", blockedOn: "Bash: git push" } } });
  });

  it("inside a Run, a run worker's finish comes from its mail only, while a plain owned worker's finish comes from hook state", async () => {
    const twoRows = (runState: string, plainState: string): OrcaResult => ({ ok: true, result: { worktrees: [
      { path: "/w/x", worktreeId: "r::/w/x", comment: "orca-mcp:tester", agents: [{ paneKey: "tab:leaf", state: runState, stateStartedAt: 1_000_000, lastAssistantMessage: "Run worker finished." }] },
      { path: "/w/p", worktreeId: "r::/w/p", comment: "orca-mcp:tester", agents: [{ paneKey: "t2:l2", state: plainState, stateStartedAt: 1_000_000, lastAssistantMessage: "Plain worker finished." }] },
    ] } });
    const o = scripted(
      {
        "orchestration worker-list": [{ ok: true, result: { workers: [{ dispatchId: "disp_1", workspace: "r::/w/x" }] } }],
        "orchestration check": [{ ok: true, result: { messages: [], timedOut: true } }],
        "terminal list": [terms],
        "worktree ps": [twoRows("done", "done")],
      },
      { orchestration: true },
    );
    const r = await o.call("orca_wait", { run: "run_1", timeoutMs: 300_000 });
    expect(r).toMatchObject({ state: "done", summary: expect.stringContaining("Plain worker finished.") });
    // The run worker's hook done is never reported; with no mail the wait times out.
    const again = await o.call("orca_wait", { run: "run_1", timeoutMs: 300_000 });
    expect(again).toMatchObject({ state: "working", data: { via: "mail" } });
  });
});

describe("orca_agent_status", () => {
  const fleet: OrcaResult = {
    ok: true,
    result: {
      worktrees: [
        other,
        { path: "/w/x", worktreeId: "r::/w/x", displayName: "fix-login", branch: "refs/heads/fix-login", comment: "orca-mcp:tester", agents: [{ paneKey: "tab:leaf", agentType: "claude", state: "working", stateStartedAt: 1_000_000 - 180_000, toolName: "Bash", lastAssistantMessage: "Running the suite." }] },
        { path: "/w/y", worktreeId: "r::/w/y", displayName: "docs", branch: "refs/heads/docs", comment: "orca-mcp:tester", agents: [{ paneKey: "t2:l2", agentType: "codex", state: "blocked", stateStartedAt: 1_000_000 - 30_000, toolName: "apply_patch" }] },
        { path: "/w/z", worktreeId: "r::/w/z", displayName: "closed", comment: "notes orca-mcp:tester", agents: [] },
      ],
    },
  };

  it("one call gives each of this client's workers state, since, tool, blocked-on, last message, terminal and dispatch ids", async () => {
    const o = scripted({ "worktree ps": [fleet], "terminal list": [terms], "orchestration worker-list": [{ ok: true, result: { workers: [{ dispatchId: "disp_9", taskId: "task_9", state: "ready", terminal: "term_2", workspace: "r::/w/y" }] } }] }, { orchestration: true });
    const r = await o.call("orca_agent_status", {});
    expect(r.state).toBe("blocked");
    expect(r.summary).toBe("3 workers: 1 working, 1 blocked, 1 idle.");
    const workers = r.data.workers as Record<string, unknown>[];
    expect(workers[0]).toMatchObject({ worktree: "/w/x", branch: "fix-login", terminal: "term_1", state: "working", since: new Date(820_000).toISOString(), tool: "Bash", lastAssistantMessage: "Running the suite.", summary: "fix-login (claude) working for 3m, running Bash" });
    expect(workers[1]).toMatchObject({ terminal: "term_2", state: "blocked", blockedOn: "apply_patch", dispatchId: "disp_9", taskId: "task_9", summary: "docs (codex) blocked for 30s on apply_patch" });
    expect(workers[2]).toMatchObject({ worktree: "/w/z", state: "idle", summary: "closed: no live agent" });
    expect(r.text).not.toContain("OWNER-PRIVATE");
  });

  it("the local plugin's pushed states apply only to the local Orca, never to a paired environment", async () => {
    let overlays = 0;
    const bridge: PushSource = { connected: () => true, seq: () => 0, overlay: (rows) => (overlays++, rows), changed: async () => false };
    const replies: Record<string, OrcaResult[]> = { "worktree ps": [fleet], "terminal list": [terms], "orchestration worker-list": [{ ok: true, result: { workers: [] } }] };
    await scripted(replies, { orchestration: true, deps: { bridge } }).call("orca_agent_status", {});
    expect(overlays).toBe(1);
    const paired = { orchestration: true, caps: [EXTERNAL_COORDINATOR_CAPABILITY], envExtra: { ORCA_MCP_ENVIRONMENT: "this-mac" }, deps: { bridge } };
    expect((await scripted(replies, paired).call("orca_agent_status", {})).state).toBe("blocked");
    expect(overlays).toBe(1);
  });

  it("scope all lists everyone's agents without their messages; a named dispatch uses worker-show for what it waits on", async () => {
    const o = scripted(
      {
        "worktree ps": [fleet],
        "terminal list": [terms],
        "orchestration worker-list": [{ ok: true, result: { workers: [] } }],
        "orchestration worker-show": [{ ok: true, result: { dispatchId: "disp_9", taskId: "task_9", runId: "run_3", terminal: "term_2", workspace: "r::/w/y", waitingOnHuman: "agent-trust-workspace (via hook)" } }],
      },
      { orchestration: true },
    );
    const all = await o.call("orca_agent_status", { scope: "all" });
    expect((all.data.workers as unknown[]).length).toBe(3);
    expect(all.text).not.toContain("OWNER-PRIVATE");
    expect(JSON.stringify(all.data)).not.toContain("OWNER-PRIVATE");
    const one = await o.call("orca_agent_status", { dispatch: "disp_9" });
    expect(one).toMatchObject({ state: "blocked", summary: "docs (codex) blocked for 30s on agent-trust-workspace (via hook)", data: { runId: "run_3" } });
    expect((one.data.workers as Record<string, unknown>[])[0]).toMatchObject({ dispatchId: "disp_9", taskId: "task_9", blockedOn: "agent-trust-workspace (via hook)" });
  });

  it("works without orchestration from hook state alone", async () => {
    const o = scripted({ "worktree ps": [fleet], "terminal list": [terms] });
    const r = await o.call("orca_agent_status", { terminal: "term_1" });
    expect(r).toMatchObject({ state: "working", summary: "fix-login (claude) working for 3m, running Bash" });
    expect(o.kinds()).toEqual(["worktree ps", "terminal list"]);
  });
});

describe("capability awareness", () => {
  it("without the capability, a configured environment is not used and every call is today's", async () => {
    const o = scripted({ "orchestration run-create": [{ ok: true, result: { run: { id: "run_8" } } }] }, { orchestration: true, caps: ["orchestration.contract.v1"], envExtra: { ORCA_MCP_ENVIRONMENT: "this-mac" } });
    const r = await o.call("orca_run_create", { objective: "ship it" });
    expect(r).toMatchObject({ summary: "Run run_8 created (coordinator legacy).", data: { coordinator: "legacy" } });
    await o.call("orca_send", { to: "dispatch:disp_1", body: "rebase first" });
    await o.call("orca_worker_start", { repo: "/nowhere/repo", name: "w", spec: "s" });
    expect(o.kinds()).toEqual(["orchestration run-create", "orchestration send", "orchestration worker-start"]);
    expect(o.calls[2]).toContain("--worktree=new-top-level");
    expect(o.calls.flat().some((a) => a.startsWith("--from") || a.startsWith("--environment") || a === "--external")).toBe(false);
  });

  it("without ORCA_MCP_ENVIRONMENT the capability alone changes nothing", async () => {
    const o = scripted({ "orchestration run-create": [{ ok: true, result: { run: { id: "run_8" } } }] }, { orchestration: true, caps: [EXTERNAL_COORDINATOR_CAPABILITY] });
    expect((await o.call("orca_run_create", { objective: "a" })).data.coordinator).toBe("legacy");
    await o.call("orca_wait", { run: "run_8", timeoutMs: 1000 });
    expect(o.calls[0]).toEqual(["orchestration", "run-create", "--objective=a"]);
    expect(o.calls.flat().some((a) => a.startsWith("--environment") || a === "--external")).toBe(false);
  });

  it("a legacy run-create refused for want of a pane says why and how to proceed", async () => {
    const o = scripted({ "orchestration run-create": [{ ok: false, error: "orca error: run-create needs a stable Orca pane", code: "stable_pane_required" }] }, { orchestration: true });
    const r = await o.call("orca_run_create", { objective: "x" });
    expect(r.isError).toBe(true);
    expect(r.summary).toMatch(/stable Orca pane \(no external coordinator: ORCA_MCP_ENVIRONMENT is not set; orca_worker_start with a spec creates its own Run\)/);
    const lacking = await scripted({ "orchestration run-create": [{ ok: false, error: "orca error: needs a pane", code: "stable_pane_required" }] }, { orchestration: true, envExtra: { ORCA_MCP_ENVIRONMENT: "this-mac" } }).call("orca_run_create", { objective: "x" });
    expect(lacking.summary).toMatch(/no external coordinator: environment this-mac lacks orchestration\.external-coordinator\.v1;/);
  });

  it("an orchestration probe failure is not cached, a success is", async () => {
    let n = 0;
    const replies: OrcaResult[] = [{ ok: false, error: "orca runtime not running" }, { ok: true, result: { runs: [] } }];
    const probe = orchestrationProbe(async () => replies[Math.min(n++, 1)]!);
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(true);
    expect(await probe()).toBe(true);
    expect(n).toBe(2);
  });
});
