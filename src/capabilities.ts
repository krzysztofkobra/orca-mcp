import type { OrcaResult, OrcaRunner } from "./orca.js";

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

/** Whether `orca orchestration` works on this host (it is a togglable feature). Checked once per process. */
export function orchestrationProbe(run: OrcaRunner): () => Promise<boolean> {
  let cached: Promise<boolean> | null = null;
  return () => {
    cached ??= run(["orchestration", "run-list", "--limit=1"], { timeoutMs: 10_000 }).then((r) => r.ok);
    return cached;
  };
}

export type CoordinatorMode = { kind: "external"; id: string } | { kind: "legacy"; reason: string };

export interface CoordinatorAdapter {
  /** How coordinator calls identify this server. Registers an external coordinator on first use when the runtime supports it. */
  mode(): Promise<CoordinatorMode>;
  /** Extra argv for coordinator calls (run-create, task-create, worker-start, check, send); empty in legacy mode. */
  fromArgs(): Promise<string[]>;
}

/**
 * The one place that knows the upstream command names for external
 * coordinators, so a rename upstream changes only this adapter. Legacy mode is
 * today's behaviour: no identity flag, Orca resolves the caller as it always has.
 */
export function coordinatorAdapter(run: OrcaRunner, capabilities: () => Promise<ReadonlySet<string>>, label: () => string): CoordinatorAdapter {
  let registered: Promise<CoordinatorMode> | undefined;
  const register = async (): Promise<CoordinatorMode> => {
    const caps = await capabilities();
    if (!caps.has(EXTERNAL_COORDINATOR_CAPABILITY)) return { kind: "legacy", reason: `runtime lacks ${EXTERNAL_COORDINATOR_CAPABILITY}` };
    const r: OrcaResult = await run(["orchestration", "external", "register", `--label=${label()}`], { timeoutMs: 15_000 });
    if (!r.ok) return { kind: "legacy", reason: `external register failed: ${r.error}` };
    const res = r.result as { id?: unknown; externalId?: unknown; coordinator?: { id?: unknown } } | undefined;
    const raw = [res?.id, res?.externalId, res?.coordinator?.id].find((v): v is string => typeof v === "string" && v.length > 0);
    if (!raw) return { kind: "legacy", reason: "external register returned no id" };
    return { kind: "external", id: raw.replace(/^external:/, "") };
  };
  const mode = () => {
    registered ??= register().then((m) => {
      // Retry a failed registration on the next call instead of pinning legacy mode for the whole process.
      if (m.kind === "legacy") registered = undefined;
      return m;
    });
    return registered;
  };
  return {
    mode,
    fromArgs: async () => {
      const m = await mode();
      return m.kind === "external" ? [`--from=external:${m.id}`] : [];
    },
  };
}
