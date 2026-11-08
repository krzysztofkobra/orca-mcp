import type { OrcaRunner } from "./orca.js";

/** Advertised by an Orca runtime that accepts a coordinator with no terminal pane (upstream stablyai/orca#15828). */
export const EXTERNAL_COORDINATOR_CAPABILITY = "orchestration.external-coordinator.v1";

/** Capability ids from `orca status --json` (`result.runtime.capabilities`). */
export function capabilitiesOf(status: unknown): string[] {
  const caps = (status as { runtime?: { capabilities?: unknown } } | undefined)?.runtime?.capabilities;
  return Array.isArray(caps) ? caps.filter((c): c is string => typeof c === "string") : [];
}

/**
 * Reads the runtime's capabilities once (`status` plus `args`, e.g. the saved environment to ask).
 * A failed read is not cached: Orca may simply not be running yet when the server starts.
 */
export function capabilityProbe(run: OrcaRunner, args: readonly string[] = []): { get: () => Promise<ReadonlySet<string>>; seed: (status: unknown) => void } {
  let cached: ReadonlySet<string> | undefined;
  let pending: Promise<ReadonlySet<string>> | undefined;
  return {
    get: () => {
      if (cached) return Promise.resolve(cached);
      pending ??= run(["status", ...args], { timeoutMs: 10_000 }).then((r) => {
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

export type CoordinatorMode = { kind: "external"; environment: string } | { kind: "legacy"; reason: string };

export interface CoordinatorAdapter {
  /** How coordinator calls identify this server: as the paired device of a saved environment, or as today. */
  mode(): Promise<CoordinatorMode>;
  /** Extra argv of a coordinator call: `--environment=<name>` in external mode, nothing in legacy mode. */
  args(): Promise<string[]>;
}

/**
 * The one place that knows how upstream identifies an external coordinator
 * (stablyai/orca docs/site/content/docs/cli/orchestration.mdx "External coordinators",
 * src/cli/handlers/orchestration/run-handlers.ts), so a change upstream changes only this adapter.
 * The identity is a saved runtime environment the owner paired by hand (`orca environment add`);
 * every coordinator call passes `--environment=<name>` and Orca binds the Run to that paired
 * device. orca-mcp holds no credential of its own. Legacy mode is today's behaviour: Orca
 * resolves the caller as it always has.
 */
export function coordinatorAdapter(capabilities: () => Promise<ReadonlySet<string>>, environment: string | undefined): CoordinatorAdapter {
  const mode = async (): Promise<CoordinatorMode> => {
    if (!environment) return { kind: "legacy", reason: "ORCA_MCP_ENVIRONMENT is not set" };
    // Re-read until it succeeds: the capability set is cached once read.
    const caps = await capabilities();
    return caps.has(EXTERNAL_COORDINATOR_CAPABILITY) ? { kind: "external", environment } : { kind: "legacy", reason: `environment ${environment} lacks ${EXTERNAL_COORDINATOR_CAPABILITY} or is unreachable` };
  };
  return {
    mode,
    args: async () => {
      const m = await mode();
      return m.kind === "external" ? [`--environment=${m.environment}`] : [];
    },
  };
}
