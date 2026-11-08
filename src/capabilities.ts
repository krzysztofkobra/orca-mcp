import type { OrcaRunner } from "./orca.js";

/** Advertised by an Orca runtime that accepts a coordinator with no terminal pane (upstream stablyai/orca#15828). */
export const EXTERNAL_COORDINATOR_CAPABILITY = "orchestration.external-coordinator.v1";

/** Capability ids from `orca status --json` (`result.runtime.capabilities`). */
export function capabilitiesOf(status: unknown): string[] {
  const caps = (status as { runtime?: { capabilities?: unknown } } | undefined)?.runtime?.capabilities;
  return Array.isArray(caps) ? caps.filter((c): c is string => typeof c === "string") : [];
}

/** How long a failed capability read is reused before the next one: waits call often, a read can take 10 s. */
export const FAILED_PROBE_MS = 30_000;

/**
 * Reads the runtime's capabilities once (`status` plus `args`, e.g. the saved environment to ask).
 * `get` rejects when the read fails. A failure is kept for `FAILED_PROBE_MS` only: Orca may simply
 * not be running yet when the server starts.
 */
export function capabilityProbe(run: OrcaRunner, args: readonly string[] = [], now: () => number = Date.now): { get: () => Promise<ReadonlySet<string>>; seed: (status: unknown) => void } {
  let cached: ReadonlySet<string> | undefined;
  let failed: { error: string; until: number } | undefined;
  let pending: Promise<ReadonlySet<string>> | undefined;
  return {
    get: () => {
      if (cached) return Promise.resolve(cached);
      if (failed && now() < failed.until) return Promise.reject(new Error(failed.error));
      pending ??= run(["status", ...args], { timeoutMs: 10_000 }).then((r) => {
        pending = undefined;
        if (!r.ok) {
          failed = { error: r.error, until: now() + FAILED_PROBE_MS };
          throw new Error(r.error);
        }
        failed = undefined;
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

export type CoordinatorMode =
  | { kind: "external"; environment: string }
  | { kind: "legacy"; reason: string }
  /** ORCA_MCP_ENVIRONMENT is set but its runtime cannot be read: every call fails closed, none goes to local Orca. */
  | { kind: "unavailable"; environment: string; reason: string };

export interface CoordinatorAdapter {
  /** How every orca call identifies this server: as the paired device of a saved environment, or as today. */
  mode(): Promise<CoordinatorMode>;
}

/**
 * The one place that knows how upstream identifies an external coordinator
 * (stablyai/orca docs/site/content/docs/cli/orchestration.mdx "External coordinators",
 * src/cli/handlers/orchestration/run-handlers.ts), so a change upstream changes only this adapter.
 * The identity is a saved runtime environment the owner paired by hand (`orca environment add`);
 * in external mode every orca call passes `--environment=<name>` and Orca binds the Run to that
 * paired device. orca-mcp holds no credential of its own. Legacy mode is today's behaviour: Orca
 * resolves the caller as it always has.
 */
export function coordinatorAdapter(capabilities: () => Promise<ReadonlySet<string>>, environment: string | undefined): CoordinatorAdapter {
  // The first mode read from a successful probe holds for the process, so one session never
  // switches between the paired environment and local Orca. Only a failed read is retried.
  let settled: CoordinatorMode | undefined;
  return {
    mode: async () => {
      if (settled) return settled;
      if (!environment) return (settled = { kind: "legacy", reason: "ORCA_MCP_ENVIRONMENT is not set" });
      let caps: ReadonlySet<string>;
      try {
        caps = await capabilities();
      } catch (err) {
        return { kind: "unavailable", environment, reason: `Orca environment ${environment} (ORCA_MCP_ENVIRONMENT) cannot be reached: ${err instanceof Error ? err.message : String(err)}` };
      }
      settled ??= caps.has(EXTERNAL_COORDINATOR_CAPABILITY) ? { kind: "external", environment } : { kind: "legacy", reason: `environment ${environment} lacks ${EXTERNAL_COORDINATOR_CAPABILITY}` };
      return settled;
    },
  };
}
