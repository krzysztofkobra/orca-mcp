import { z } from "zod";
import {
  aggregateState,
  aggregateSummary,
  clientLabel,
  needsAttention,
  normalizeState,
  ownerComment,
  ownerOf,
  psRows,
  realish,
  stripRef,
  terminalRows,
  underPath,
  workerRows,
  workerStatus,
  worktreePathOfId,
  type PsAgent,
  type PsRow,
  type WorkerListRow,
  type WorkerStatus,
} from "./agent-state.js";
import { capabilitiesOf, capabilityProbe, coordinatorAdapter, EXTERNAL_COORDINATOR_CAPABILITY, orchestrationProbe, type CoordinatorAdapter } from "./capabilities.js";
import { checkPath } from "./paths.js";
import { runOrca, type OrcaResult, type OrcaRunner } from "./orca.js";

/*
 * Tool -> orca argv. Flags checked against `orca agent-context --json` and
 * `orca <cmd> --help` on CLI 1.4.250. Every value goes as `--flag=value`, so a
 * value starting with `-` can never be read as a flag of its own. `--json` is
 * appended by runOrca. `<from>` is `--from=external:<id>` when the runtime
 * supports external coordinators (see capabilities.ts), else nothing.
 *
 * | tool                  | argv                                                                                         |
 * |-----------------------|----------------------------------------------------------------------------------------------|
 * | orca_status           | status                                                                                       |
 * | orca_repos            | repo list                                                                                    |
 * | orca_repo_add         | repo add --path=<abs>                                                                        |
 * | orca_worktrees        | worktree ps [--limit=<n>]                                                                    |
 * | orca_worktree_create  | worktree create --name= --repo=path:<abs> --agent= --prompt= --no-parent --comment=orca-mcp:<client> [--model=] [--effort=] [--base-branch=] |
 * | orca_terminal_read    | terminal read --terminal= [--cursor=] [--limit=] [--screen]                                  |
 * | orca_terminal_send    | terminal send --terminal= [--text=] [--enter] [--interrupt]                                  |
 * | orca_terminal_wait    | for=done: terminal show --terminal=, then worktree ps every pollMs (the pane's hook state)  |
 * |   for=exit|tui-idle   | terminal wait --terminal= --for=exit|tui-idle --timeout-ms=                                  |
 * | orca_run_create       | [orchestration external register] orchestration run-create --objective= <from>               |
 * | orca_task_create      | orchestration task-create --spec= [--task-title=] [--run=] [--deps=] <from>                  |
 * | orca_worker_start     | orchestration worker-start (--task=|--spec=) --worktree=new-top-level --repo= --name= --agent= --comment= [--model= [--effort=]] [--run=] <from> |
 * |   no orchestration    | as orca_worktree_create with the spec as prompt                                              |
 * | orca_check            | with terminal (no run): as orca_terminal_wait for=done, or terminal read for peek            |
 * |   else                | orchestration check (--wait --timeout-ms=|--peek) [--run=] [--terminal=] <from>              |
 * | orca_agent_status     | worktree ps + terminal list [+ orchestration worker-list] [+ worker-show --dispatch=]        |
 * | orca_wait             | run known: orchestration check --run= --peek --wait --types=worker_done,escalation <from>    |
 * |   else                | worktree ps every pollMs (hook state of one terminal, one worktree, or every owned worker)  |
 * | orca_worker_read      | orchestration worker-read --dispatch= [--cursor=] [--limit=]  |  terminal read --terminal=   |
 * | orca_worker_stop      | orchestration worker-stop --dispatch=  |  terminal close --terminal=                         |
 * | orca_send             | orchestration send --to= --subject= [--body=] [--type=] [--run=] <from>  |  terminal send --text= --enter |
 * | orca_search           | search --query= [--limit=] [--scope=]                                                        |
 * | orca_worktree_rm      | worktree rm --worktree=path:<abs> [--force]                                                  |
 */

export interface WorkerInfo {
  /** `term:<handle>` or `dispatch:<id>`; unique per agent. */
  key: string;
  terminal?: string;
  dispatch?: string;
  task?: string;
  run?: string;
  repo?: string;
  worktree?: string;
  branch?: string;
  agent: string;
  model?: string;
  prompt?: string;
  /** The branch the worktree started from, when the start named one. */
  base?: string;
  /** The client tag written into the worktree's Orca comment. */
  owner: string;
}

/**
 * Every tool result: a text block whose first line is `<state>: <summary>`, and the
 * same facts as `structuredContent`. Results that start an agent carry `worker`,
 * results that stop one carry `stopped`.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: { state: string; summary: string; [key: string]: unknown };
  isError?: boolean;
}

export interface ToolDeps {
  run?: OrcaRunner;
  env?: NodeJS.ProcessEnv;
  orchestration?: () => Promise<boolean>;
  capabilities?: () => Promise<ReadonlySet<string>>;
  coordinator?: CoordinatorAdapter;
  /** The client name workers are tagged with (`orca-mcp:<client>`); read per call, the MCP client is known only after initialize. */
  client?: () => string | undefined;
  /**
   * Called after every tool with its parsed arguments and result; a returned
   * result replaces it. The seam for embedders that add their own markers,
   * accounting or policy around these tools.
   */
  onToolResult?: (name: string, args: unknown, result: ToolResult) => ToolResult | void | Promise<ToolResult | void>;
  /** Clock and sleep of the waits (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often hook-state waits read `worktree ps`. */
  pollMs?: number;
}

export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: never) => Promise<ToolResult>;
}

const reply = (state: string, summary: string, o: { details?: string | undefined; data?: Record<string, unknown> } = {}): ToolResult => ({
  content: [{ type: "text", text: `${state}: ${summary}${o.details ? `\n${o.details}` : ""}` }],
  structuredContent: { ...o.data, state, summary },
});
const ok = (summary: string, o?: { details?: string | undefined; data?: Record<string, unknown> }) => reply("ok", summary, o);
const fail = (summary: string, data?: Record<string, unknown>): ToolResult => ({ ...reply("error", summary, data ? { data } : {}), isError: true });

/** An Orca terminal handle, dispatch or run id: starts alphanumeric, so it can never read as a flag. */
export const ORCA_HANDLE = /^[A-Za-z0-9][\w:.@/-]{0,199}$/;
const handle = z.string().min(1).max(200).regex(ORCA_HANDLE, "not a valid Orca handle or id");
const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9][\w.-]*$/, "use letters, digits, '.', '_' or '-'");
const agent = z.string().min(1).max(40).regex(/^[a-z0-9][\w.-]*$/, "an Orca agent id such as claude, codex or opencode");
const model = z.string().min(1).max(100).regex(/^[A-Za-z0-9][\w.:/-]*$/, "not a model id");
const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const text = (max: number) => z.string().min(1).max(max);
const absPath = z.string().min(1).max(1024).describe("Absolute path");

/** Short timeouts for reads, longer for creation (setup hooks run), waits get their own + margin. */
const READ_MS = 30_000;
const CREATE_MS = 180_000;
const MAX_WAIT_MS = 600_000;
const POLL_MS = 5000;
/** A pane whose agent reports no hook state this long (an agent kind without Orca hooks) falls back to tui-idle; a cold Claude boot can take a minute. */
const HOOKLESS_MS = 120_000;
/** Consecutive failed `worktree ps` reads before a wait says Orca is unreachable. */
const PS_FAILS = 3;
const WAKE_TYPES = ["worker_done", "escalation"];

function compact(v: unknown, max = 8000): string {
  const s = JSON.stringify(v);
  return s === undefined ? "(no result)" : s.length > max ? `${s.slice(0, max)}... [cut at ${max} chars; ask for less with limit/cursor]` : s;
}

/** Value at the first of several dotted paths that holds a non-empty string. */
function pick(obj: unknown, paths: string[]): string | undefined {
  for (const p of paths) {
    let cur: unknown = obj;
    for (const k of p.split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
    if (typeof cur === "string" && cur) return cur;
  }
  return undefined;
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

type MailMessage = { id?: string; type?: string; from?: string; subject?: string; body?: string; payload?: unknown };

export function buildTools(deps: ToolDeps = {}): ToolDef[] {
  const env = deps.env ?? process.env;
  const runner = deps.run ?? runOrca;
  const run = (args: string[], timeoutMs = READ_MS) => runner(args, { timeoutMs, env });
  const caps = deps.capabilities ? { get: deps.capabilities, seed: () => {} } : capabilityProbe((args, o) => runner(args, { ...o, env }));
  const orchestration = deps.orchestration ?? orchestrationProbe((args, o) => runner(args, { ...o, env }));
  const client = () => clientLabel(env.ORCA_MCP_CLIENT?.trim() || deps.client?.() || undefined);
  const now = deps.now ?? Date.now;
  const coord = deps.coordinator ?? coordinatorAdapter((args, o) => runner(args, { ...o, env }), caps.get, client, now);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = deps.pollMs ?? POLL_MS;

  // terminal -> when this process last typed into it: a done state from before that is the previous turn's.
  const lastSend = new Map<string, number>();
  // pane -> the last event an any-of wait returned for it, so each finish is reported once.
  const reported = new Map<string, string>();
  // Mail ids orca_wait already returned (peek never marks mail read).
  const seenMail = new Set<string>();
  // Runs this process created or joined, newest last.
  const runs: string[] = [];
  const rememberRun = (id: string | undefined) => {
    if (!id) return;
    const i = runs.indexOf(id);
    if (i >= 0) runs.splice(i, 1);
    runs.push(id);
  };

  const repoSel = (raw: string): { sel: string; path: string } | { error: string } => {
    const c = checkPath(raw, env);
    return "error" in c ? c : { sel: `path:${c.path}`, path: c.path };
  };

  /**
   * A worktree this server may act on: inside the roots itself, or a worktree Orca
   * created for a repo inside the roots (Orca may place worktrees elsewhere).
   */
  const worktreeSel = async (raw: string): Promise<{ sel: string; path: string } | { error: string }> => {
    const direct = checkPath(raw, env);
    if (!("error" in direct)) return { sel: `path:${direct.path}`, path: direct.path };
    const [wts, repos] = await Promise.all([run(["worktree", "list"]), run(["repo", "list"])]);
    if (!wts.ok || !repos.ok) return direct;
    const want = realish(raw.trim());
    const rows = ((wts.result as { worktrees?: { path?: string; repoId?: string }[] })?.worktrees ?? []).filter((w) => w.path && realish(w.path) === want);
    const repoPaths = new Map(((repos.result as { repos?: { id?: string; path?: string }[] })?.repos ?? []).map((r) => [r.id, r.path]));
    for (const w of rows) {
      const repoPath = repoPaths.get(w.repoId);
      if (repoPath && !("error" in checkPath(repoPath, env))) return { sel: `path:${w.path}`, path: w.path! };
    }
    return direct;
  };

  const terminalOfPane = async (paneKey: string | undefined): Promise<string | undefined> => {
    if (!paneKey) return undefined;
    const t = await run(["terminal", "list"]);
    return t.ok ? terminalRows(t.result).find((x) => `${x.tabId}:${x.leafId}` === paneKey)?.handle : undefined;
  };

  /** A single terminal's turn, by the state Orca's agent hooks report for its pane. */
  const waitTerminal = async (terminal: string, timeoutMs: number, note?: string): Promise<ToolResult> => {
    const since = lastSend.get(terminal) ?? 0;
    const start = now();
    const deadline = start + timeoutMs;
    const shown = await run(["terminal", "show", `--terminal=${terminal}`]);
    if (!shown.ok) return fail(shown.error);
    const t = (shown.result as { terminal?: { tabId?: string; leafId?: string }; tabId?: string; leafId?: string }) ?? {};
    const tab = t.terminal?.tabId ?? t.tabId;
    const leaf = t.terminal?.leafId ?? t.leafId;
    let last: { row: PsRow; pane: PsAgent } | undefined;
    let sawWorking = false;
    let psFails = 0;
    // stateStartedAt of a messageless done seen on the previous read.
    let quietDone: string | undefined;
    const details = (s: string) => (note ? `${note}\n${s}` : s);
    if (tab && leaf) {
      const key = `${tab}:${leaf}`;
      for (;;) {
        const ps = await run(["worktree", "ps"], 10_000);
        if (!ps.ok && ++psFails >= PS_FAILS) return fail(`Orca is not answering (worktree ps failed ${psFails} times): ${ps.error}`);
        if (ps.ok) psFails = 0;
        let hit: { row: PsRow; pane: PsAgent } | undefined;
        if (ps.ok) for (const row of psRows(ps.result)) for (const pane of row.agents ?? []) if (pane.paneKey === key) hit = { row, pane };
        if (hit) last = hit;
        const pane = hit?.pane;
        const raw = typeof pane?.state === "string" ? pane.state : "";
        const state = normalizeState(raw);
        if (state === "working") sawWorking = true;
        // After a send, a state counts once it started after the send, or (no timestamp) once the agent was seen working again.
        const fresh = since === 0 || (typeof pane?.stateStartedAt === "number" ? pane.stateStartedAt >= since : sawWorking);
        const msg = typeof pane?.lastAssistantMessage === "string" ? pane.lastAssistantMessage.trim().slice(0, 4000) : "";
        const status = () => workerStatus(hit!.row, pane, { terminal, includeMessage: true, now: now() });
        // A new pane reports done for a moment while the agent boots, with nothing said yet:
        // a messageless done counts once the next read still shows the same one.
        if (state === "done" && fresh && (msg || quietDone === String(pane!.stateStartedAt ?? ""))) {
          reported.set(key, `done:${String(pane!.stateStartedAt ?? "")}`);
          return reply("done", `Agent done${msg ? `: ${oneLine(msg, 160)}` : "."}`, { details: details(`${msg ? `Its last message: ${msg}\n` : ""}Read the full output with orca_terminal_read.`), data: { via: "hook", worker: status() } });
        }
        quietDone = state === "done" ? String(pane!.stateStartedAt ?? "") : undefined;
        if (needsAttention(state) && fresh) {
          const w = status();
          reported.set(key, `${state}:${String(pane!.stateStartedAt ?? "")}`);
          return reply(state, `Agent is ${state} (${raw}${w.blockedOn && w.blockedOn !== raw ? `, on ${oneLine(w.blockedOn, 80)}` : ""}).`, {
            details: details("Read its screen (orca_terminal_read, screen true), then answer with orca_terminal_send or bring the question back."),
            data: { via: "hook", worker: w },
          });
        }
        if (!last && now() - start >= HOOKLESS_MS) break;
        if (now() >= deadline) {
          const tool = typeof last?.pane.toolName === "string" ? `, last tool ${last.pane.toolName}` : "";
          return reply("working", `Still running after ${Math.round((now() - start) / 1000)} s${tool}.`, { details: details("Wait again with orca_wait."), data: { via: "hook", ...(last ? { worker: workerStatus(last.row, last.pane, { terminal, includeMessage: false, now: now() }) } : {}) } });
        }
        await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      }
    }
    // No pane behind the terminal, or its agent reports no hook state: the TUI's own idle signal.
    const rest = Math.max(1000, deadline - now());
    const r = await run(["terminal", "wait", `--terminal=${terminal}`, "--for=tui-idle", `--timeout-ms=${rest}`], rest + 15_000);
    if (!r.ok) return fail(r.error);
    return reply("idle", "Terminal idle by the TUI signal; the agent reports no hook state, so it may not be done.", { details: details(`Read its output before you trust it. ${compact(r.result, 2000)}`), data: { via: "tui-idle", result: r.result } });
  };

  /** The first worker among several that finishes or stops for a human; each event is returned once per process. */
  const waitAny = async (match: (row: PsRow) => boolean, label: string, timeoutMs: number, note?: string): Promise<ToolResult> => {
    const start = now();
    const deadline = start + timeoutMs;
    const quiet = new Map<string, string>();
    let psFails = 0;
    let watched = 0;
    const details = (s: string) => (note ? `${note}\n${s}` : s);
    for (;;) {
      const ps = await run(["worktree", "ps"], 10_000);
      if (!ps.ok && ++psFails >= PS_FAILS) return fail(`Orca is not answering (worktree ps failed ${psFails} times): ${ps.error}`);
      if (ps.ok) {
        psFails = 0;
        const rows = psRows(ps.result).filter(match);
        watched = rows.reduce((n, r) => n + (r.agents?.length ?? 0), 0);
        if (!rows.length) return reply("idle", `No ${label} to wait on.`, { details: note, data: { via: "hook", workers: [] } });
        // A young worktree whose agent has not reported yet (booting) is pending; an old one without agents is a closed worker.
        let pending = rows.filter((r) => !r.agents?.length && now() - (r.createdAt ?? r.lastActivityAt ?? 0) < HOOKLESS_MS).length;
        for (const row of rows) {
          for (const pane of row.agents ?? []) {
            if (!pane.paneKey) continue;
            const state = normalizeState(pane.state);
            const stamp = String(pane.stateStartedAt ?? "");
            const msg = typeof pane.lastAssistantMessage === "string" ? pane.lastAssistantMessage.trim() : "";
            const seenQuiet = quiet.get(pane.paneKey) === stamp;
            if (state === "done") quiet.set(pane.paneKey, stamp);
            else quiet.delete(pane.paneKey);
            const event = `${state}:${stamp}`;
            if (reported.get(pane.paneKey) === event) continue;
            pending++;
            if ((state === "done" && (msg || seenQuiet)) || needsAttention(state)) {
              reported.set(pane.paneKey, event);
              const w = workerStatus(row, pane, { terminal: await terminalOfPane(pane.paneKey), includeMessage: true, now: now() });
              return reply(state, w.summary, {
                details: details(state === "done" ? `${msg ? `Its last message: ${msg.slice(0, 4000)}\n` : ""}Read the full output with orca_terminal_read.` : "Read its screen (orca_terminal_read, screen true), then answer it or bring the question back."),
                data: { via: "hook", worker: w },
              });
            }
          }
        }
        // Every agent already reported (done, or waiting on a human): nothing new can come without a send.
        if (!pending) return reply("idle", `Nothing new in the ${label}: all ${watched} agent${watched === 1 ? "" : "s"} already reported.`, { details: details("Send follow-ups (orca_send) or start workers, then wait again."), data: { via: "hook" } });
      }
      if (now() - start >= HOOKLESS_MS && watched === 0 && ps.ok) return reply("idle", `No live agent in the ${label} after ${Math.round((now() - start) / 1000)} s.`, { details: note, data: { via: "hook" } });
      if (now() >= deadline) return reply("working", `Still running after ${Math.round((now() - start) / 1000)} s (${watched} agent${watched === 1 ? "" : "s"} in the ${label}).`, { details: details("Wait again with orca_wait."), data: { via: "hook" } });
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  };

  /**
   * Waits on a Run's mailbox without taking mail (`--peek`), so the Run's own
   * coordinator still gets every message. Returns null with the failure when the
   * mailbox cannot be read this way, so the caller can fall back to hook state.
   */
  const waitMail = async (runId: string, timeoutMs: number, fromDispatch?: string): Promise<{ event: ToolResult } | { failed: OrcaResult & { ok: false } }> => {
    const start = now();
    const deadline = start + timeoutMs;
    const from = await coord.fromArgs();
    let waitArgs = true;
    for (;;) {
      const rest = Math.max(1000, deadline - now());
      const args = ["orchestration", "check", `--run=${runId}`, "--peek", `--types=${WAKE_TYPES.join(",")}`, ...(waitArgs ? ["--wait", `--timeout-ms=${rest}`] : []), ...from];
      const r = await run(args, waitArgs ? rest + 15_000 : READ_MS);
      if (!r.ok) return { failed: r };
      const res = r.result as { messages?: MailMessage[]; timedOut?: boolean } | undefined;
      const fresh = (res?.messages ?? []).filter((m) => m.id && !seenMail.has(m.id) && WAKE_TYPES.includes(m.type ?? "") && (!fromDispatch || m.from === fromDispatch || m.from === `dispatch:${fromDispatch}`));
      const m = fresh[0];
      if (m) {
        seenMail.add(m.id!);
        const payload = m.payload as { outcome?: unknown; status?: unknown } | undefined;
        const failed = m.type === "worker_done" && (payload?.outcome === "failed" || payload?.status === "failed");
        const state = m.type === "worker_done" ? (failed ? "failed" : "done") : "blocked";
        const dispatchId = m.from?.replace(/^dispatch:/, "");
        const about = oneLine(m.subject || m.body || "", 160);
        return { event: reply(state, `Worker ${dispatchId ?? "?"} ${m.type === "worker_done" ? (failed ? "failed" : "done") : "escalated"}${about ? `: ${about}` : ""}`, {
          details: `${m.body ? `${m.body.slice(0, 4000)}\n` : ""}${m.type === "escalation" ? "Answer with orca_send (to dispatch:<id>), or bring it back to the user." : "Read its output with orca_worker_read."}${fresh.length > 1 ? `\n${fresh.length - 1} more event(s) waiting: call orca_wait again.` : ""}`,
          data: { via: "mail", runId, event: { type: m.type, messageId: m.id, dispatchId, subject: m.subject, body: m.body?.slice(0, 4000), payload: m.payload } },
        }) };
      }
      if (now() >= deadline || res?.timedOut) return { event: reply("working", `No worker_done or escalation in run ${runId} after ${Math.round((now() - start) / 1000)} s.`, { details: "Wait again with orca_wait.", data: { via: "mail", runId } }) };
      // Unread mail this process already returned makes a peek wait return at once: poll until it is read or new mail comes.
      waitArgs = !res?.messages?.length;
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  };

  /** Starts an agent in a fresh worktree the stable way (no orchestration). */
  const createWorktreeAgent = async (a: { repo: string; name: string; agent: string; prompt: string; model?: string | undefined; effort?: string | undefined; baseBranch?: string | undefined }): Promise<ToolResult> => {
    const repo = repoSel(a.repo);
    if ("error" in repo) return fail(repo.error);
    const owner = client();
    const args = ["worktree", "create", `--name=${a.name}`, `--repo=${repo.sel}`, `--agent=${a.agent}`, `--prompt=${a.prompt}`, "--no-parent", `--comment=${ownerComment(owner)}`];
    if (a.model) args.push(`--model=${a.model}`);
    if (a.effort) args.push(`--effort=${a.effort}`);
    if (a.baseBranch) args.push(`--base-branch=${a.baseBranch}`);
    const r = await run(args, CREATE_MS);
    if (!r.ok) return fail(r.error);
    const terminal = pick(r.result, ["launch.outcome.handle", "agentTerminalHandle", "startupTerminal.handle", "worktree.agentTerminalHandle"]);
    const worktree = pick(r.result, ["worktree.path", "path", "worktree.git.path"]);
    const branch = stripRef(pick(r.result, ["worktree.branch", "branch", "worktree.git.branch"]));
    const head = `Worktree ${worktree ?? a.name} created${branch ? ` on ${branch}` : ""}, ${a.agent} started${terminal ? ` in terminal ${terminal}` : ""}.`;
    if (!terminal) {
      return fail(`${head} But Orca returned no agent terminal handle, so this server cannot wait on the agent. Do not start it again: find it with orca_agent_status. Orca's reply: ${compact(r.result, 2000)}`, { worktree, owner });
    }
    const worker: WorkerInfo = { key: `term:${terminal}`, terminal, repo: repo.path, ...(worktree ? { worktree } : {}), ...(branch ? { branch } : {}), ...(a.baseBranch ? { base: a.baseBranch } : {}), agent: a.agent, ...(a.model ? { model: a.model } : {}), prompt: a.prompt.slice(0, 500), owner };
    return reply("working", head, { details: `Wait with orca_wait (terminal ${terminal}), then read with orca_terminal_read.`, data: { worker } });
  };

  const startWorker = async (a: { task?: string | undefined; spec?: string | undefined; repo: string; name: string; agent: string; model?: string | undefined; effort?: string | undefined; run?: string | undefined }): Promise<ToolResult> => {
    const repo = repoSel(a.repo);
    if ("error" in repo) return fail(repo.error);
    if (a.effort && !a.model) return fail("effort needs model");
    const owner = client();
    const args = ["orchestration", "worker-start", a.task ? `--task=${a.task}` : `--spec=${a.spec}`, "--worktree=new-top-level", `--repo=${repo.sel}`, `--name=${a.name}`, `--agent=${a.agent}`, `--comment=${ownerComment(owner)}`];
    if (a.model) args.push(`--model=${a.model}`);
    if (a.effort) args.push(`--effort=${a.effort}`);
    if (a.run) args.push(`--run=${a.run}`);
    args.push(...(await coord.fromArgs()));
    const r = await run(args, CREATE_MS);
    if (!r.ok) return fail(r.error, r.code ? { code: r.code } : undefined);
    const dispatch = pick(r.result, ["dispatchId", "dispatch.id", "dispatch_id", "id"]);
    const task = pick(r.result, ["taskId", "task.id"]);
    const runId = pick(r.result, ["runId", "run.id"]);
    const terminal = pick(r.result, ["terminal", "terminal.handle", "terminalHandle", "agentTerminalHandle"]);
    const worktree = pick(r.result, ["worktree.path", "worktreePath", "placement.worktreePath"]) ?? worktreePathOfId(pick(r.result, ["workspace"]));
    const branch = stripRef(pick(r.result, ["worktree.branch", "branch"]));
    rememberRun(runId);
    const head = `Worker started (${a.agent}${a.model ? `, ${a.model}` : ""})${dispatch ? `, dispatch ${dispatch}` : ""}${worktree ? ` in ${worktree}` : ""}.`;
    if (!dispatch) return reply("unknown", head, { details: `Orca returned no dispatch id: ${compact(r.result, 2000)}`, data: { result: r.result } });
    const worker: WorkerInfo = {
      key: `dispatch:${dispatch}`,
      dispatch,
      ...(task ? { task } : {}),
      ...(runId ? { run: runId } : {}),
      ...(terminal ? { terminal } : {}),
      repo: repo.path,
      ...(worktree ? { worktree } : {}),
      ...(branch ? { branch } : {}),
      agent: a.agent,
      ...(a.model ? { model: a.model } : {}),
      prompt: (a.spec ?? `task ${a.task}`).slice(0, 500),
      owner,
    };
    if (pick(r.result, ["state"]) === "failed") return fail(`${head} But it failed: ${pick(r.result, ["lastError", "failedStage"]) ?? compact(r.result, 1000)}`, { worker });
    return reply("working", head, { details: `Wait with orca_wait (dispatch ${dispatch}), read with orca_worker_read.`, data: { worker } });
  };

  const agentStatus = async (a: { terminal?: string | undefined; dispatch?: string | undefined; worktree?: string | undefined; scope?: "mine" | "all" | undefined }): Promise<ToolResult> => {
    // Embedders may call handlers without the schema's defaults.
    const scope = a.scope ?? "mine";
    const orch = await orchestration();
    const [ps, terms, workers, shown] = await Promise.all([
      run(["worktree", "ps"]),
      run(["terminal", "list"]),
      orch ? run(["orchestration", "worker-list", "--limit=100"]) : Promise.resolve<OrcaResult>({ ok: true, result: {} }),
      a.dispatch && orch ? run(["orchestration", "worker-show", `--dispatch=${a.dispatch}`]) : Promise.resolve<OrcaResult | undefined>(undefined),
    ]);
    if (!ps.ok) return fail(ps.error);
    if (shown && !shown.ok) return fail(shown.error);
    const handleOf = new Map<string, string>();
    if (terms.ok) for (const t of terminalRows(terms.result)) if (t.handle && t.tabId && t.leafId) handleOf.set(`${t.tabId}:${t.leafId}`, t.handle);
    const wl = workers.ok ? workerRows(workers.result) : [];
    const show = shown?.ok ? (shown.result as WorkerListRow & { runId?: string; waitingOnHuman?: string; lastError?: string }) : undefined;
    if (show) wl.unshift({ ...show, dispatchId: show.dispatchId ?? a.dispatch });
    const me = client();
    const named = !!(a.terminal || a.dispatch || a.worktree);
    const wantDispatch = a.dispatch ? wl.find((w) => w.dispatchId === a.dispatch) : undefined;
    if (a.dispatch && !wantDispatch) return fail(orch ? `Orca knows no dispatch ${a.dispatch}` : "dispatch ids need Orca orchestration, which is disabled here");
    const out: WorkerStatus[] = [];
    for (const row of psRows(ps.result)) {
      const owner = ownerOf(row.comment);
      if (!named && scope === "mine" && owner !== me) continue;
      if (a.worktree && !(row.path && underPath(row.path, a.worktree))) continue;
      const rowOfDispatch = !!wantDispatch?.workspace && (wantDispatch.workspace === row.worktreeId || worktreePathOfId(wantDispatch.workspace) === row.path);
      const agents = row.agents?.length ? row.agents : [undefined];
      for (const pane of agents) {
        const terminal = pane?.paneKey ? handleOf.get(pane.paneKey) : undefined;
        if (a.terminal && terminal !== a.terminal) continue;
        if (wantDispatch && !rowOfDispatch && !(wantDispatch.terminal && terminal === wantDispatch.terminal)) continue;
        if (!pane && scope === "all" && !named) continue;
        const dispatch = (terminal ? wl.find((w) => w.terminal === terminal) : undefined) ?? wl.find((w) => w.workspace && w.workspace === row.worktreeId);
        const blockedOn = dispatch === wantDispatch && show?.waitingOnHuman && show.waitingOnHuman !== "unknown" ? show.waitingOnHuman : undefined;
        // Other people's agents show their state, never their messages, unless asked for by name.
        out.push(workerStatus(row, pane, { ...(terminal ? { terminal } : {}), ...(dispatch ? { dispatch } : {}), ...(blockedOn ? { blockedOn } : {}), includeMessage: named || owner === me, now: now() }));
      }
    }
    if (a.terminal && !out.length) return fail(`No agent behind terminal ${a.terminal} in worktree ps (it may have exited, or its agent reports no hook state).`);
    const state = aggregateState(out);
    const summary = out.length === 1 ? out[0]!.summary : aggregateSummary(out);
    const details = out.length > 1 ? out.map((w) => `- ${w.summary}${w.terminal ? ` [${w.terminal}]` : ""}${w.dispatchId ? ` [dispatch ${w.dispatchId}]` : ""}`).join("\n") : out[0]?.lastAssistantMessage ? `Last message: ${out[0].lastAssistantMessage}` : undefined;
    const scopeNote = !named && scope === "mine" ? { client: me } : {};
    return reply(state, summary, { details, data: { workers: out, ...scopeNote, ...(show?.runId ? { runId: show.runId } : {}) } });
  };

  const tools: ToolDef[] = [
    {
      name: "orca_status",
      description: "Orca app and runtime status: is Orca running and reachable, its version, whether orchestration and external coordinators are available.",
      shape: {},
      handler: async () => {
        const r = await run(["status"]);
        if (!r.ok) return fail(r.error);
        caps.seed(r.result);
        const s = r.result as { app?: { running?: boolean }; runtime?: { state?: string; appVersion?: string; reachable?: boolean } };
        const capList = capabilitiesOf(r.result);
        const external = capList.includes(EXTERNAL_COORDINATOR_CAPABILITY);
        const orch = s.runtime?.reachable === false ? false : await orchestration();
        const summary = `Orca app ${s.app?.running ? "running" : "not running"}, runtime ${s.runtime?.state ?? "unknown"}${s.runtime?.appVersion ? `, version ${s.runtime.appVersion}` : ""}, orchestration ${orch ? "on" : "off"}, external coordinator ${external ? "supported" : "not supported"}.`;
        return reply(s.runtime?.state === "ready" ? "ok" : (s.runtime?.state ?? "unknown"), summary, {
          data: { app: { running: !!s.app?.running }, runtime: { state: s.runtime?.state, version: s.runtime?.appVersion }, orchestration: orch, externalCoordinator: external, capabilities: capList.length },
        });
      },
    },
    {
      name: "orca_repos",
      description: "Repositories registered in Orca (name, path).",
      shape: {},
      handler: async () => {
        const r = await run(["repo", "list"]);
        if (!r.ok) return fail(r.error);
        const repos = (r.result as { repos?: { displayName?: string; path?: string; id?: string }[] })?.repos ?? [];
        return ok(repos.length ? `${repos.length} repo${repos.length === 1 ? "" : "s"} in Orca.` : "No repos in Orca.", {
          details: repos.map((x) => `- ${x.displayName ?? "?"}: ${x.path ?? "?"}`).join("\n") || undefined,
          data: { repos: repos.map((x) => ({ id: x.id, name: x.displayName, path: x.path })) },
        });
      },
    },
    {
      name: "orca_repo_add",
      description: "Register an existing git repository (absolute path inside the allowed roots) with Orca.",
      shape: { path: absPath },
      handler: async (a: { path: string }) => {
        const c = checkPath(a.path, env);
        if ("error" in c) return fail(c.error);
        const r = await run(["repo", "add", `--path=${c.path}`]);
        return r.ok ? ok(`Repo ${c.path} added to Orca.`, { data: { path: c.path } }) : fail(r.error);
      },
    },
    {
      name: "orca_worktrees",
      description: "Worktrees with their live agents (status, agent type and state, branch, owner). Optional repo path filter; mine=true lists only worktrees this client started.",
      shape: { repo: absPath.optional(), mine: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() },
      handler: async (a: { repo?: string | undefined; mine?: boolean | undefined; limit?: number | undefined }) => {
        const r = await run(["worktree", "ps", ...(a.limit ? [`--limit=${a.limit}`] : [])]);
        if (!r.ok) return fail(r.error);
        const me = client();
        let rows = psRows(r.result);
        if (a.repo) rows = rows.filter((w) => !!w.path && underPath(w.path, a.repo!));
        if (a.mine) rows = rows.filter((w) => ownerOf(w.comment) === me);
        if (!rows.length) return ok("No matching worktrees.", { data: { worktrees: [] } });
        const list = rows.map((w) => ({
          path: w.path,
          branch: stripRef(w.branch),
          status: w.status,
          owner: ownerOf(w.comment),
          agents: (w.agents ?? []).map((g) => ({ agent: typeof g.agentType === "string" ? g.agentType : undefined, state: normalizeState(g.state) })),
        }));
        const details = list
          .map((w) => {
            const agents = w.agents.map((g) => `${g.agent ?? "agent"}:${g.state}`).join(", ");
            return `- ${w.path ?? "?"} [${w.branch ?? "?"}] ${w.status ?? ""}${w.owner ? ` owner=${w.owner}` : ""}${agents ? ` agents: ${agents}` : ""}`;
          })
          .join("\n");
        const live = list.reduce((n, w) => n + w.agents.length, 0);
        return ok(`${list.length} worktree${list.length === 1 ? "" : "s"}, ${live} live agent${live === 1 ? "" : "s"}.`, { details, data: { worktrees: list } });
      },
    },
    {
      name: "orca_worktree_create",
      description:
        "Create a new worktree in a repo and start a coding agent in it with the task prompt (optional model and effort). The worktree is tagged as this client's, so orca_agent_status and orca_wait find it after a restart. Returns the agent's terminal handle.",
      shape: {
        repo: absPath.describe("Absolute path of a repo registered in Orca"),
        name: name.describe("Worktree/branch name"),
        agent: agent.default("claude"),
        prompt: text(20_000).describe("The task for the agent, self-contained"),
        model: model.optional(),
        effort: effort.optional(),
        baseBranch: name.optional(),
      },
      handler: async (a: { repo: string; name: string; agent: string; prompt: string; model?: string | undefined; effort?: string | undefined; baseBranch?: string | undefined }) => createWorktreeAgent(a),
    },
    {
      name: "orca_terminal_read",
      description: "Read an agent terminal's output (stripped of escapes). Use cursor from the previous read to get only new output; screen=true for the rendered screen.",
      shape: { terminal: handle, cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(2000).optional(), screen: z.boolean().optional() },
      handler: async (a: { terminal: string; cursor?: number | undefined; limit?: number | undefined; screen?: boolean | undefined }) => {
        if (a.screen && a.cursor !== undefined) return fail("screen and cursor cannot be combined");
        const args = ["terminal", "read", `--terminal=${a.terminal}`];
        if (a.cursor !== undefined) args.push(`--cursor=${a.cursor}`);
        if (a.limit) args.push(`--limit=${a.limit}`);
        if (a.screen) args.push("--screen");
        return readResult(await run(args), `terminal ${a.terminal}`);
      },
    },
    {
      name: "orca_terminal_send",
      description: "Type text into an agent terminal (enter=true submits it) or interrupt it. For orchestration workers prefer orca_send.",
      shape: { terminal: handle, text: text(20_000).optional(), enter: z.boolean().optional(), interrupt: z.boolean().optional() },
      handler: async (a: { terminal: string; text?: string | undefined; enter?: boolean | undefined; interrupt?: boolean | undefined }) => {
        if (!a.text && !a.enter && !a.interrupt) return fail("nothing to send: give text, enter or interrupt");
        const args = ["terminal", "send", `--terminal=${a.terminal}`];
        if (a.text) args.push(`--text=${a.text}`);
        if (a.enter) args.push("--enter");
        if (a.interrupt) args.push("--interrupt");
        lastSend.set(a.terminal, now());
        const r = await run(args);
        return r.ok ? ok(`Sent to ${a.terminal}.`) : fail(r.error);
      },
    },
    {
      name: "orca_terminal_wait",
      description:
        'Block until the agent in a terminal is done with its turn (default: Orca\'s hook state, returns within seconds of it finishing, or at once when it waits for input), up to timeoutMs (max 600000). On "working" just wait again. for exit or tui-idle waits on the terminal itself.',
      shape: { terminal: handle, for: z.enum(["done", "tui-idle", "exit"]).default("done"), timeoutMs: z.number().int().min(1000).max(MAX_WAIT_MS).default(300_000) },
      handler: async (a: { terminal: string; for?: string | undefined; timeoutMs: number }) => {
        if (a.for !== "exit" && a.for !== "tui-idle") return waitTerminal(a.terminal, a.timeoutMs);
        const r = await run(["terminal", "wait", `--terminal=${a.terminal}`, `--for=${a.for}`, `--timeout-ms=${a.timeoutMs}`], a.timeoutMs + 15_000);
        return r.ok ? reply(a.for === "exit" ? "exited" : "idle", `Terminal ${a.terminal} reached ${a.for}.`, { data: { result: r.result } }) : fail(r.error);
      },
    },
    {
      name: "orca_agent_status",
      description:
        "Status of coding agents in one call: per worker its state (working, waiting, blocked, done, idle), since when, the tool it runs, what it waits on, its last message, dispatch and task ids. Default scope: workers this client started (found again after a restart through their Orca worktree tag). Name a terminal, dispatch or worktree to look at one; scope all lists every agent (without their messages).",
      shape: { terminal: handle.optional(), dispatch: handle.optional(), worktree: absPath.optional(), scope: z.enum(["mine", "all"]).default("mine") },
      handler: async (a: { terminal?: string | undefined; dispatch?: string | undefined; worktree?: string | undefined; scope: "mine" | "all" }) => agentStatus(a),
    },
    {
      name: "orca_wait",
      description:
        "Block server-side until a worker finishes or needs a human, then return one structured event (state done, failed, waiting or blocked, plus the worker and its last message). With a run (or a dispatch, or a run this server created) it waits on the Run's worker_done and escalation mail without taking it; otherwise on Orca's hook state for one terminal, one worktree, or every worker this client started. Each event is returned once, so calling orca_wait in a loop walks through them. On state working the timeout passed: wait again.",
      shape: { run: handle.optional(), dispatch: handle.optional(), terminal: handle.optional(), worktree: absPath.optional(), timeoutMs: z.number().int().min(1000).max(MAX_WAIT_MS).default(300_000) },
      handler: async (a: { run?: string | undefined; dispatch?: string | undefined; terminal?: string | undefined; worktree?: string | undefined; timeoutMs: number }) => {
        const started = now();
        const orch = await orchestration();
        let terminal = a.terminal;
        let runId = a.run;
        if (a.dispatch) {
          if (!orch) return fail("dispatch ids need Orca orchestration, which is disabled here: pass the agent's terminal");
          const shown = await run(["orchestration", "worker-show", `--dispatch=${a.dispatch}`]);
          if (!shown.ok) return fail(shown.error);
          runId ??= pick(shown.result, ["runId"]);
          terminal ??= pick(shown.result, ["terminal"]);
        }
        const targetless = !a.run && !a.dispatch && !a.terminal && !a.worktree;
        if (targetless) runId = runs.at(-1);
        let note: string | undefined;
        if (runId && orch) {
          const m = await waitMail(runId, a.timeoutMs, a.dispatch);
          if ("event" in m) return m.event;
          if (a.run && !terminal && !a.worktree) return fail(m.failed.error, m.failed.code ? { code: m.failed.code } : undefined);
          note = `Run mailbox unreadable (${m.failed.code ?? m.failed.error}); waited on hook state instead.`;
        }
        const rest = Math.max(1000, a.timeoutMs - (now() - started));
        if (terminal) return waitTerminal(terminal, rest, note);
        if (a.worktree) {
          const c = checkPath(a.worktree, env);
          const base = "error" in c ? a.worktree : c.path;
          return waitAny((row) => !!row.path && underPath(row.path, base), `worktree ${base}`, rest, note);
        }
        const me = client();
        return waitAny((row) => ownerOf(row.comment) === me, `workers of ${me}`, rest, note);
      },
    },
    {
      name: "orca_run_create",
      description:
        "Create an Orca orchestration Run (a namespace and inbox for tasks and workers). Needs orchestration. When the runtime supports external coordinators this server registers as one first, so the Run needs no terminal pane.",
      shape: { objective: text(2000) },
      handler: async (a: { objective: string }) => {
        if (!(await orchestration())) return fail("Orca orchestration is disabled here; use orca_worktree_create (worktree + agent) instead");
        const mode = await coord.mode();
        const r = await run(["orchestration", "run-create", `--objective=${a.objective}`, ...(mode.kind === "external" ? [`--from=external:${mode.id}`] : [])]);
        const coordinator = mode.kind === "external" ? `external:${mode.id}` : "legacy";
        if (!r.ok) {
          const hint = mode.kind === "legacy" ? ` (no external coordinator: ${mode.reason}; orca_worker_start with a spec creates its own Run)` : "";
          return fail(`${r.error}${hint}`, { coordinator, ...(r.code ? { code: r.code } : {}) });
        }
        const runId = pick(r.result, ["runId", "run.id", "id"]);
        rememberRun(runId);
        return ok(`Run ${runId ?? "?"} created (coordinator ${coordinator}).`, { details: "Start workers with orca_worker_start (run), wait with orca_wait.", data: { runId, coordinator, result: r.result } });
      },
    },
    {
      name: "orca_task_create",
      description: "Create an orchestration Task (spec) in a Run. Needs orchestration.",
      shape: { spec: text(20_000), title: text(200).optional(), run: handle.optional(), deps: z.array(handle).max(50).optional() },
      handler: async (a: { spec: string; title?: string | undefined; run?: string | undefined; deps?: string[] | undefined }) => {
        if (!(await orchestration())) return fail("Orca orchestration is disabled here; use orca_worktree_create (worktree + agent) instead");
        const args = ["orchestration", "task-create", `--spec=${a.spec}`];
        if (a.title) args.push(`--task-title=${a.title}`);
        if (a.run) args.push(`--run=${a.run}`);
        if (a.deps?.length) args.push(`--deps=${JSON.stringify(a.deps)}`);
        args.push(...(await coord.fromArgs()));
        const r = await run(args);
        if (!r.ok) return fail(r.error);
        const taskId = pick(r.result, ["taskId", "task.id", "id"]);
        return ok(`Task ${taskId ?? "?"} created.`, { data: { taskId, result: r.result } });
      },
    },
    {
      name: "orca_worker_start",
      description:
        "Start a coding agent on a task (or a spec) in a new worktree of a repo. Uses Orca orchestration; when that is disabled it falls back to worktree create with the spec as prompt. The worktree is tagged as this client's. Then call orca_wait.",
      shape: { repo: absPath, name, agent: agent.default("claude"), task: handle.optional(), spec: text(20_000).optional(), model: model.optional(), effort: effort.optional(), run: handle.optional() },
      handler: async (a: { repo: string; name: string; agent: string; task?: string | undefined; spec?: string | undefined; model?: string | undefined; effort?: string | undefined; run?: string | undefined }) => {
        if (!a.task === !a.spec) return fail("give exactly one of task or spec");
        if (await orchestration()) return startWorker(a);
        if (!a.spec) return fail("Orca orchestration is disabled here: tasks are unavailable, pass the work as spec");
        return createWorktreeAgent({ repo: a.repo, name: a.name, agent: a.agent, prompt: a.spec, model: a.model, effort: a.effort });
      },
    },
    {
      name: "orca_check",
      description:
        "With an agent's terminal: wait until that agent is done (as orca_terminal_wait), or peek at its output. With a run (orchestration): take the Run's worker messages (worker_done, questions) up to timeoutMs, or peek. Prefer orca_wait, which never takes mail.",
      shape: { run: handle.optional(), terminal: handle.optional(), peek: z.boolean().optional(), timeoutMs: z.number().int().min(1000).max(MAX_WAIT_MS).default(120_000) },
      handler: async (a: { run?: string | undefined; terminal?: string | undefined; peek?: boolean | undefined; timeoutMs: number }) => {
        if (a.terminal && !a.run) {
          if (a.peek) return readResult(await run(["terminal", "read", `--terminal=${a.terminal}`, "--limit=40"]), `terminal ${a.terminal}`);
          return waitTerminal(a.terminal, a.timeoutMs);
        }
        if (!(await orchestration())) return fail("Orca orchestration is disabled here: pass the agent's terminal to wait on");
        const args = ["orchestration", "check"];
        if (a.run) args.push(`--run=${a.run}`);
        if (a.terminal) args.push(`--terminal=${a.terminal}`);
        if (a.peek) args.push("--peek");
        else args.push("--wait", `--timeout-ms=${a.timeoutMs}`);
        args.push(...(await coord.fromArgs()));
        const r = await run(args, a.peek ? READ_MS : a.timeoutMs + 15_000);
        if (!r.ok) return fail(r.error);
        const res = r.result as { messages?: MailMessage[]; timedOut?: boolean };
        const msgs = res?.messages ?? [];
        const done = msgs.some((m) => m.type === "worker_done");
        const asks = msgs.some((m) => m.type === "question" || m.type === "escalation");
        const summary = msgs.length ? `${msgs.length} message${msgs.length === 1 ? "" : "s"}: ${msgs.map((m) => `${m.type ?? "?"} from ${m.from ?? "?"}`).join(", ")}.` : res?.timedOut ? "No messages before the timeout." : "No messages.";
        return reply(asks ? "waiting" : done ? "done" : msgs.length ? "ok" : "working", summary, { details: msgs.length ? compact(msgs, 8000) : undefined, data: { messages: msgs } });
      },
    },
    {
      name: "orca_worker_read",
      description: "Read a worker's output: by dispatch id (orchestration) or by agent terminal handle.",
      shape: { dispatch: handle.optional(), terminal: handle.optional(), cursor: z.union([z.string().max(500), z.number().int().min(0)]).optional(), limit: z.number().int().min(1).max(2000).optional() },
      handler: async (a: { dispatch?: string | undefined; terminal?: string | undefined; cursor?: string | number | undefined; limit?: number | undefined }) => {
        if (!a.dispatch === !a.terminal) return fail("give exactly one of dispatch or terminal");
        const args = a.dispatch ? ["orchestration", "worker-read", `--dispatch=${a.dispatch}`] : ["terminal", "read", `--terminal=${a.terminal}`];
        if (a.cursor !== undefined) args.push(`--cursor=${a.cursor}`);
        if (a.limit) args.push(`--limit=${a.limit}`);
        return readResult(await run(args), a.dispatch ? `dispatch ${a.dispatch}` : `terminal ${a.terminal}`);
      },
    },
    {
      name: "orca_worker_stop",
      description: "Stop a worker (by dispatch id) or close an agent terminal (by handle). Never deletes the worktree.",
      shape: { dispatch: handle.optional(), terminal: handle.optional() },
      handler: async (a: { dispatch?: string | undefined; terminal?: string | undefined }) => {
        if (!a.dispatch === !a.terminal) return fail("give exactly one of dispatch or terminal");
        const r = a.dispatch ? await run(["orchestration", "worker-stop", `--dispatch=${a.dispatch}`]) : await run(["terminal", "close", `--terminal=${a.terminal}`]);
        if (!r.ok) return fail(r.error);
        const key = a.dispatch ? `dispatch:${a.dispatch}` : `term:${a.terminal}`;
        return reply("stopped", `Stopped ${key}.`, { data: { stopped: { key } } });
      },
    },
    {
      name: "orca_send",
      description: "Message a worker: orchestration mail (to: run:<id> | dispatch:<id>) or, without orchestration, type text + Enter into its terminal.",
      shape: { to: handle.optional(), terminal: handle.optional(), subject: text(200).optional(), body: text(20_000), type: z.enum(["status", "dispatch", "handoff", "question", "escalation"]).optional(), run: handle.optional() },
      handler: async (a: { to?: string | undefined; terminal?: string | undefined; subject?: string | undefined; body: string; type?: string | undefined; run?: string | undefined }) => {
        if (a.terminal) {
          lastSend.set(a.terminal, now());
          const r = await run(["terminal", "send", `--terminal=${a.terminal}`, `--text=${a.body}`, "--enter"]);
          return r.ok ? ok(`Sent to ${a.terminal}.`) : fail(r.error);
        }
        if (!(await orchestration())) return fail("Orca orchestration is disabled here: pass the agent's terminal instead");
        if (!a.to) return fail("give to (run:<id> or dispatch:<id>) or terminal");
        const args = ["orchestration", "send", `--to=${a.to}`, `--subject=${a.subject ?? a.body.slice(0, 80)}`, `--body=${a.body}`];
        if (a.type) args.push(`--type=${a.type}`);
        if (a.run) args.push(`--run=${a.run}`);
        args.push(...(await coord.fromArgs()));
        const r = await run(args);
        return r.ok ? ok(`Sent to ${a.to}.`, { data: { result: r.result } }) : fail(r.error);
      },
    },
    {
      name: "orca_search",
      description: "Search past agent conversations and terminal output in Orca.",
      shape: { query: text(500), limit: z.number().int().min(1).max(100).optional(), scope: z.enum(["conversation", "all"]).optional() },
      handler: async (a: { query: string; limit?: number | undefined; scope?: string | undefined }) => {
        const args = ["search", `--query=${a.query}`];
        if (a.limit) args.push(`--limit=${a.limit}`);
        if (a.scope) args.push(`--scope=${a.scope}`);
        const r = await run(args);
        if (!r.ok) return fail(r.error);
        const s = r.result as { kind?: string; reason?: string };
        if (s?.kind === "unavailable") return reply("unavailable", `Orca search is unavailable (${s.reason ?? "unknown"}).`);
        return ok("Search results.", { details: compact(r.result), data: { result: r.result } });
      },
    },
    {
      name: "orca_worktree_rm",
      description: "Remove a worktree (and its local branch when Orca can prove it is merged). Destructive.",
      shape: { worktree: absPath, force: z.boolean().optional() },
      handler: async (a: { worktree: string; force?: boolean | undefined }) => {
        const wt = await worktreeSel(a.worktree);
        if ("error" in wt) return fail(wt.error);
        const r = await run(["worktree", "rm", `--worktree=${wt.sel}`, ...(a.force ? ["--force"] : [])], CREATE_MS);
        if (!r.ok) return fail(r.error);
        return reply("removed", `Removed worktree ${wt.path}.`, { data: { stopped: { worktree: wt.path } } });
      },
    },
  ];

  const hook = deps.onToolResult;
  return tools.map((t) => {
    const schema = z.object(t.shape);
    return {
      ...t,
      // The MCP SDK validates already; embedders calling a handler directly get the same defaults and checks.
      handler: async (raw: never) => {
        const parsed = schema.safeParse(raw ?? {});
        if (!parsed.success) return fail(`invalid arguments for ${t.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
        const args = parsed.data as never;
        const r = await t.handler(args);
        return hook ? ((await hook(t.name, args, r)) ?? r) : r;
      },
    };
  });
}

/** Terminal/worker output as plain text plus the cursor for the next read. */
function readResult(r: OrcaResult, what: string): ToolResult {
  if (!r.ok) return fail(r.error);
  const v = r.result as { tail?: unknown; output?: unknown; lines?: unknown; text?: unknown; nextCursor?: unknown };
  const body = [v?.tail, v?.output, v?.text, v?.lines].find((x) => typeof x === "string" || Array.isArray(x));
  if (body === undefined) return ok(`Read ${what}.`, { details: compact(r.result), data: { result: r.result } });
  const textOut = Array.isArray(body) ? body.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") : (body as string);
  const cut = textOut.length > 20_000 ? `[earlier output cut]\n${textOut.slice(-20_000)}` : textOut;
  const lines = textOut ? textOut.split("\n").length : 0;
  const cursor = v.nextCursor !== undefined ? String(v.nextCursor) : undefined;
  return ok(`Read ${lines} line${lines === 1 ? "" : "s"} from ${what}${cursor !== undefined ? `, next cursor ${cursor}` : ""}.`, { details: cut, data: { ...(cursor !== undefined ? { nextCursor: cursor } : {}) } });
}
