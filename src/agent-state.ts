import { realpathSync } from "node:fs";
import { sep } from "node:path";

/*
 * Shapes pinned from stablyai/orca source (HEAD 8995b036):
 * - `worktree ps`: src/shared/runtime-worktree-contracts.ts `RuntimeWorktreePsSummary` and
 *   `RuntimeWorktreeAgentRow`; agent `state` is `AgentStatusState` = working|blocked|waiting|done
 *   (src/shared/agent-status/contracts/agent-status-types.ts).
 * - `terminal list`: rows carry `handle`, `tabId`, `leafId`, `worktreeId`; an agent row's
 *   `paneKey` is `<tabId>:<leafId>`.
 * - `orchestration worker-list` / `worker-show` concise JSON: src/cli/handlers/orchestration/worker-agent-views.ts.
 * - `orchestration check` concise JSON: src/cli/handlers/orchestration/message-agent-views.ts
 *   (`messages[]` of `{ id, type, from, subject?, body?, payload? }`, `from` without its `dispatch:` prefix).
 */

/** Prefix of the worktree comment that marks a worker this server started; the rest names the client. */
export const OWNER_TAG = "orca-mcp:";
/** Only a whole whitespace-separated token counts, so `xorca-mcp:a` or `orca-mcp:a,b` in a user's note never claims a worker. */
const OWNER_RE = /(?:^|\s)orca-mcp:([\w.-]+)(?=\s|$)/;

/** The worktree comment: the caller's own note, if any, with the owner tag appended as its last token. */
export const ownerComment = (client: string, note?: string) => [note?.trim(), `${OWNER_TAG}${client}`].filter(Boolean).join(" ");
export const ownerOf = (comment: unknown) => (typeof comment === "string" ? OWNER_RE.exec(comment)?.[1] : undefined);
/** A client name safe to store in a comment and match back: letters, digits, `.`, `_`, `-`. */
export const clientLabel = (raw: string | undefined) => (raw ?? "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "orca-mcp";

export type AgentState = "working" | "blocked" | "waiting" | "done" | "idle" | "unknown";

/** Hook states of an agent that stopped for the user (permission, a question, input); providers vary in spelling. */
const WAITING_STATE = /wait|permission|input|question/i;

export function normalizeState(raw: unknown): AgentState {
  if (typeof raw !== "string" || !raw) return "unknown";
  if (raw === "working" || raw === "done" || raw === "blocked" || raw === "waiting") return raw;
  if (/block/i.test(raw)) return "blocked";
  if (WAITING_STATE.test(raw)) return "waiting";
  return "unknown";
}

export const needsAttention = (s: AgentState) => s === "waiting" || s === "blocked";

export type PsAgent = {
  paneKey?: string;
  state?: unknown;
  agentType?: unknown;
  stateStartedAt?: unknown;
  toolName?: unknown;
  toolInput?: unknown;
  lastAssistantMessage?: unknown;
  taskTitle?: unknown;
  interrupted?: unknown;
  agentWait?: { reason?: unknown; source?: unknown } | null;
};
export type PsRow = { worktreeId?: string; path?: string; repo?: string; branch?: string; status?: string; comment?: unknown; displayName?: string; createdAt?: number; lastActivityAt?: number; agents?: PsAgent[] };
export type TerminalRow = { handle?: string; tabId?: string; leafId?: string; worktreeId?: string; worktreePath?: string };
export type WorkerListRow = { dispatchId?: string; taskId?: string; state?: string; terminal?: string; workspace?: string; attention?: string[]; next?: string };

export const psRows = (v: unknown): PsRow[] => (v as { worktrees?: PsRow[] } | undefined)?.worktrees ?? [];
export const terminalRows = (v: unknown): TerminalRow[] => (v as { terminals?: TerminalRow[] } | undefined)?.terminals ?? [];
export const workerRows = (v: unknown): WorkerListRow[] => (v as { workers?: WorkerListRow[] } | undefined)?.workers ?? [];

export const stripRef = (b: string | undefined) => b?.replace(/^refs\/heads\//, "");

export const realish = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/** `path` equals `base` or lies under it, compared on a path boundary. */
export const underPath = (path: string, base: string) => {
  const p = realish(path);
  const b = realish(base);
  return p === b || p.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
};

/** Worktree path from an Orca worktree id (`<repoId>::<path>`). */
export const worktreePathOfId = (id: string | undefined) => (id && id.includes("::") ? id.slice(id.indexOf("::") + 2) : undefined);

export interface WorkerStatus {
  worktree: string;
  branch?: string;
  /** The client that started it, from the worktree's orca-mcp comment tag. */
  owner?: string;
  terminal?: string;
  paneKey?: string;
  agent?: string;
  state: AgentState;
  /** The state as Orca's hook reported it, when it differs from `state`. */
  rawState?: string;
  /** ISO time the current state started. */
  since?: string;
  lastAssistantMessage?: string;
  /** What a waiting or blocked agent waits on. */
  blockedOn?: string;
  tool?: string;
  dispatchId?: string;
  taskId?: string;
  summary: string;
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/** One worker's status from its `worktree ps` agent row, joined with its terminal and dispatch when known. */
export function workerStatus(row: PsRow, agent: PsAgent | undefined, extra: { terminal?: string; dispatch?: WorkerListRow; includeMessage: boolean; now: number; blockedOn?: string }): WorkerStatus {
  const raw = typeof agent?.state === "string" ? agent.state : undefined;
  const state: AgentState = agent ? normalizeState(raw) : "idle";
  const startedAt = typeof agent?.stateStartedAt === "number" ? agent.stateStartedAt : undefined;
  const tool = typeof agent?.toolName === "string" && agent.toolName ? agent.toolName : undefined;
  const msg = typeof agent?.lastAssistantMessage === "string" ? agent.lastAssistantMessage.trim() : "";
  const waitReason = typeof agent?.agentWait?.reason === "string" ? agent.agentWait.reason : undefined;
  const toolInput = typeof agent?.toolInput === "string" && agent.toolInput ? oneLine(agent.toolInput, 120) : undefined;
  const blockedOn = needsAttention(state) ? (extra.blockedOn ?? waitReason ?? (tool ? `${tool}${toolInput ? `: ${toolInput}` : ""}` : raw)) : undefined;
  const owner = ownerOf(row.comment);
  const name = row.displayName || (row.path ? row.path.split(/[\\/]/).pop() : undefined) || "worktree";
  const agentType = typeof agent?.agentType === "string" ? agent.agentType : undefined;
  const age = startedAt ? ` for ${formatAge(extra.now - startedAt)}` : "";
  const detail =
    state === "working"
      ? tool
        ? `, running ${tool}`
        : ""
      : needsAttention(state)
        ? blockedOn
          ? ` on ${oneLine(blockedOn, 80)}`
          : ""
        : state === "done" && msg && extra.includeMessage
          ? `: ${oneLine(msg, 100)}`
          : "";
  const summary = agent ? `${name} (${agentType ?? "agent"}) ${state}${age}${detail}` : `${name}: no live agent`;
  return {
    worktree: row.path ?? "?",
    ...(stripRef(row.branch) ? { branch: stripRef(row.branch)! } : {}),
    ...(owner ? { owner } : {}),
    ...(extra.terminal ? { terminal: extra.terminal } : {}),
    ...(agent?.paneKey ? { paneKey: agent.paneKey } : {}),
    ...(agentType ? { agent: agentType } : {}),
    state,
    ...(raw && raw !== state ? { rawState: raw } : {}),
    ...(startedAt ? { since: new Date(startedAt).toISOString() } : {}),
    ...(msg && extra.includeMessage ? { lastAssistantMessage: msg.slice(0, 2000) } : {}),
    ...(blockedOn ? { blockedOn } : {}),
    ...(tool ? { tool } : {}),
    ...(extra.dispatch?.dispatchId ? { dispatchId: extra.dispatch.dispatchId } : {}),
    ...(extra.dispatch?.taskId ? { taskId: extra.dispatch.taskId } : {}),
    summary,
  };
}

/** The fleet's state: anything needing a human first, then work in flight, then done. */
export function aggregateState(workers: readonly WorkerStatus[]): AgentState {
  const order: AgentState[] = ["waiting", "blocked", "working", "unknown", "done", "idle"];
  for (const s of order) if (workers.some((w) => w.state === s)) return s;
  return "idle";
}

export function aggregateSummary(workers: readonly WorkerStatus[]): string {
  if (!workers.length) return "No workers.";
  const counts = new Map<AgentState, number>();
  for (const w of workers) counts.set(w.state, (counts.get(w.state) ?? 0) + 1);
  const parts = [...counts].map(([s, n]) => `${n} ${s}`).join(", ");
  return `${workers.length} worker${workers.length === 1 ? "" : "s"}: ${parts}.`;
}
