import type { OrcaOptions, OrcaResult, OrcaRunner } from "./orca.js";
import type { CoordinatorStore, SavedCoordinator } from "./state-store.js";

/** Advertised by an Orca runtime that accepts a coordinator with no terminal pane (upstream stablyai/orca#15828). */
export const EXTERNAL_COORDINATOR_CAPABILITY = "orchestration.external-coordinator.v1";

/** Capability ids from `orca status --json` (`result.runtime.capabilities`). */
export function capabilitiesOf(status: unknown): string[] {
  const caps = (status as { runtime?: { capabilities?: unknown } } | undefined)?.runtime?.capabilities;
  return Array.isArray(caps) ? caps.filter((c): c is string => typeof c === "string") : [];
}

/**
 * Reads the runtime's capabilities once. A failed read is not cached: Orca may
 * simply not be running yet when the server starts.
 */
export function capabilityProbe(run: OrcaRunner): { get: () => Promise<ReadonlySet<string>>; seed: (status: unknown) => void } {
  let cached: ReadonlySet<string> | undefined;
  let pending: Promise<ReadonlySet<string>> | undefined;
  return {
    get: () => {
      if (cached) return Promise.resolve(cached);
      pending ??= run(["status"], { timeoutMs: 10_000 }).then((r) => {
        pending = undefined;
        if (!r.ok) return new Set<string>();
        cached = new Set(capabilitiesOf(r.result));
        return cached;
      });
      return pending;
    },
    seed: (status) => {
      const caps = capabilitiesOf(status);
      if (caps.length) cached = new Set(caps);
    },
  };
}

/**
 * Whether `orca orchestration` works on this host (it is a togglable feature).
 * A success is cached for the process; a failure is not, since Orca may not be running yet.
 */
export function orchestrationProbe(run: OrcaRunner): () => Promise<boolean> {
  let cached: Promise<boolean> | null = null;
  return () => {
    cached ??= run(["orchestration", "run-list", "--limit=1"], { timeoutMs: 10_000 }).then((r) => {
      if (!r.ok) cached = null;
      return r.ok;
    });
    return cached;
  };
}

/** How long a failed external register keeps this process in legacy mode before it tries again. */
export const REGISTER_RETRY_MS = 5 * 60_000;

export type CoordinatorMode = { kind: "external"; id: string } | { kind: "legacy"; reason: string };

/** Refusal codes of an external coordinator (stablyai/orca src/shared/orchestration-session-caller-codes.ts). */
export const EXTERNAL_CODES = {
  unknown: "external_coordinator_unknown",
  notOwner: "external_coordinator_not_owner",
  keyInvalid: "external_coordinator_key_invalid",
  fromAgentContext: "external_from_agent_context",
} as const;
/** A coordinator call refused with one of these means the identity this process holds is no longer good. */
const IDENTITY_LOST = new Set<string>([EXTERNAL_CODES.unknown, EXTERNAL_CODES.notOwner, EXTERNAL_CODES.keyInvalid]);

const AGENT_CONTEXT_REASON =
  "orca-mcp runs inside an Orca terminal or agent session (external_from_agent_context), where Orca lets a process act only as that terminal, so coordinator calls use today's identity";

export interface CoordinatorAdapter {
  /** How coordinator calls identify this server. Registers (or resumes) an external coordinator on first use when the runtime supports it. */
  mode(): Promise<CoordinatorMode>;
  /** Child env for coordinator calls: the identity and its key in external mode, nothing in legacy mode. */
  env(): Promise<NonNullable<OrcaOptions["coordinatorEnv"]>>;
  /** Called with the error code of a refused coordinator call; a lost identity is registered again on the next call. */
  refused(code: string | undefined): void;
  /** Keys this adapter holds, for redaction. */
  secrets(): readonly string[];
}

/**
 * The one place that knows the upstream command names for external coordinators
 * (stablyai/orca src/cli/specs/orchestration.ts `external-register`, handler in
 * src/cli/handlers/orchestration/run-handlers.ts), so a rename upstream changes only this
 * adapter. External mode: `orca orchestration external-register [--label] [--resume external:<id>]`
 * prints `{ coordinator: { id, address }, externalCoordinatorKey }`; every coordinator call then
 * carries `ORCA_EXTERNAL_COORDINATOR=external:<id>` and `ORCA_EXTERNAL_COORDINATOR_KEY` in its
 * env (never argv), and a resume needs the current key and rotates it. Legacy mode is today's
 * behaviour: Orca resolves the caller as it always has.
 */
export function coordinatorAdapter(
  run: OrcaRunner,
  capabilities: () => Promise<ReadonlySet<string>>,
  label: () => string,
  now: () => number = Date.now,
  store?: CoordinatorStore,
): CoordinatorAdapter {
  let registered: Promise<CoordinatorMode> | undefined;
  let failed: { at: number; mode: CoordinatorMode } | undefined;
  let held: SavedCoordinator | undefined;
  const seen = new Set<string>();

  const parse = (r: OrcaResult): SavedCoordinator | undefined => {
    if (!r.ok) return undefined;
    const res = r.result as { id?: unknown; coordinator?: { id?: unknown }; externalCoordinatorKey?: unknown } | undefined;
    const raw = [res?.coordinator?.id, res?.id].find((v): v is string => typeof v === "string" && v.length > 0);
    const key = res?.externalCoordinatorKey;
    return raw && typeof key === "string" && key ? { id: raw.replace(/^external:/, ""), key } : undefined;
  };
  // Never `r.error` alone for a register: Orca's message is safe, but keep it to the code and message.
  const why = (r: OrcaResult & { ok: false }) => `external-register failed${r.code ? ` (${r.code})` : ""}: ${r.error}`;

  const register = async (): Promise<CoordinatorMode> => {
    const caps = await capabilities();
    if (!caps.has(EXTERNAL_COORDINATOR_CAPABILITY)) return { kind: "legacy", reason: `runtime lacks ${EXTERNAL_COORDINATOR_CAPABILITY}` };
    const saved = held ?? store?.load();
    if (saved) {
      seen.add(saved.key);
      const r = await run(["orchestration", "external-register", `--label=${label()}`, `--resume=external:${saved.id}`], { timeoutMs: 15_000, coordinatorEnv: { ORCA_EXTERNAL_COORDINATOR_KEY: saved.key } });
      const next = parse(r);
      if (next) return adopt(next);
      if (!r.ok && r.code === EXTERNAL_CODES.fromAgentContext) return { kind: "legacy", reason: AGENT_CONTEXT_REASON };
      // Unknown id, wrong key or another owner: that identity is gone, register a fresh one below.
      if (!r.ok && !IDENTITY_LOST.has(r.code ?? "") && r.code !== "invalid_argument") return { kind: "legacy", reason: why(r) };
    }
    const r = await run(["orchestration", "external-register", `--label=${label()}`], { timeoutMs: 15_000 });
    const fresh = parse(r);
    if (fresh) return adopt(fresh);
    if (!r.ok && r.code === EXTERNAL_CODES.fromAgentContext) return { kind: "legacy", reason: AGENT_CONTEXT_REASON };
    return { kind: "legacy", reason: r.ok ? "external-register returned no id or key" : why(r) };
  };
  const adopt = (c: SavedCoordinator): CoordinatorMode => {
    held = c;
    seen.add(c.key);
    store?.save(c);
    return { kind: "external", id: c.id };
  };

  const mode = () => {
    if (failed && now() - failed.at < REGISTER_RETRY_MS) return Promise.resolve(failed.mode);
    registered ??= register().then((m) => {
      // A missing capability is re-read cheaply (the capability set is cached); a failed register waits out the retry window.
      if (m.kind === "legacy") {
        registered = undefined;
        if (!m.reason.startsWith("runtime lacks")) failed = { at: now(), mode: m };
      } else failed = undefined;
      return m;
    });
    return registered;
  };
  return {
    mode,
    env: async () => {
      const m = await mode();
      return m.kind === "external" && held ? { ORCA_EXTERNAL_COORDINATOR: `external:${m.id}`, ORCA_EXTERNAL_COORDINATOR_KEY: held.key } : {};
    },
    refused: (code) => {
      if (code === EXTERNAL_CODES.fromAgentContext) {
        registered = undefined;
        failed = { at: now(), mode: { kind: "legacy", reason: AGENT_CONTEXT_REASON } };
      } else if (code && IDENTITY_LOST.has(code)) {
        // Resume first (the saved key may still be current), else a fresh one.
        registered = undefined;
      }
    },
    secrets: () => [...seen],
  };
}
