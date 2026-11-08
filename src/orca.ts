import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAC_ORCA_BIN = "/Applications/Orca.app/Contents/Resources/bin/orca";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2000;
const WINDOWS = process.platform === "win32";

/**
 * Variables the orca CLI needs to find its runtime; nothing else from our env reaches it.
 * `ORCA_TERMINAL_HANDLE` stays out on purpose: a server started inside an Orca terminal
 * must not act as that terminal's coordinator. `ORCA_ENVIRONMENT` and `ORCA_PAIRING_CODE`
 * stay out too: the only saved environment a call uses is the one named on its argv.
 */
const ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  // Windows
  "Path",
  "PATHEXT",
  "SystemRoot",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
] as const;

export interface OrcaOptions {
  stdin?: string;
  signal?: AbortSignal;
  bin?: string;
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** More credential shapes to refuse on argv, on top of the built-in ones (an embedder's own token formats). */
  extraSecretPatterns?: readonly RegExp[];
  /** Variables set on the child on top of the passthrough list (an embedder's own, such as a screenshot dir). */
  extraEnv?: Readonly<Record<string, string>>;
}

export type OrcaResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code?: string; data?: unknown; truncated?: boolean };

export type OrcaRunner = (args: string[], opts?: OrcaOptions) => Promise<OrcaResult>;

/**
 * Credential shapes that must never reach argv (visible to every local process
 * through ps). The server adds none itself; this stops a model from pasting one
 * into a prompt or terminal text by accident.
 */
const SECRET_SHAPES = /sk-ant-[\w-]{10,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function containsSecret(args: readonly string[], extra: readonly RegExp[] = []): boolean {
  return args.some((a) => SECRET_SHAPES.test(a) || extra.some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(a)));
}

/** Whole seconds when the timeout is a whole number of seconds, else milliseconds: never a rounded "0 s". */
export function formatTimeout(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/**
 * The orca binary: `ORCA_BIN`, else the CLI bundled with an installed Orca app
 * (macOS app bundle, Linux `~/.local/bin`, Windows per-user install), else `orca`
 * from PATH.
 */
export function resolveOrcaBin(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string {
  const explicit = env.ORCA_BIN?.trim();
  if (explicit) return explicit;
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates =
    platform === "darwin"
      ? [MAC_ORCA_BIN, join(home, "Applications", "Orca.app", "Contents", "Resources", "bin", "orca")]
      : platform === "win32"
        ? [join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "Orca", "resources", "bin", "orca.exe")]
        : [join(home, ".local", "bin", "orca"), "/opt/Orca/resources/bin/orca"];
  return candidates.find((c) => exists(c)) ?? (platform === "win32" ? "orca.exe" : "orca");
}

/** Process groups of orca calls still running in this process (each child leads its own group). */
const liveGroups = new Set<number>();

/**
 * Signals every in-flight orca call's process group (shutdown path): their
 * grandchildren would otherwise outlive this process. Returns how many groups
 * were signalled.
 */
export function killAllOrcaChildren(sig: NodeJS.Signals = "SIGTERM"): number {
  let n = 0;
  for (const pgid of liveGroups) {
    try {
      process.kill(WINDOWS ? pgid : -pgid, sig);
      n++;
    } catch {
      // group already gone
    }
  }
  liveGroups.clear();
  return n;
}

/**
 * Runs `orca <args> --json` with an argv array (never a shell), a hard timeout
 * and a stdout cap, and unwraps Orca's `{ ok, result | error }` envelope.
 * Never throws: every failure comes back as `{ ok: false, error }`.
 */
export function runOrca(args: readonly string[], opts: OrcaOptions = {}): Promise<OrcaResult> {
  const src = opts.env ?? process.env;
  // A coordinator on the same computer as Orca saves its pairing in a profile of its own:
  // Orca refuses to save a pairing code into the profile of the runtime it points at.
  const profile = src.ORCA_MCP_CLIENT_PROFILE?.trim();
  const withProfile = profile ? { ...opts, extraEnv: { ...opts.extraEnv, ORCA_USER_DATA_PATH: profile } } : opts;
  return runJsonCli("orca", opts.bin ?? resolveOrcaBin(src), args, withProfile, unwrapOrca);
}

function unwrapOrca(parsed: unknown, code: number | null): OrcaResult {
  const e = parsed as { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
  if (e && e.ok === true) return { ok: true, result: e.result };
  const errCode = typeof e?.error?.code === "string" ? e.error.code : undefined;
  const message = typeof e?.error?.message === "string" ? e.error.message : `exit ${code ?? "signal"}`;
  return { ok: false, error: `orca error: ${message}`, ...(errCode ? { code: errCode } : {}), ...(e?.error?.data !== undefined ? { data: e.error.data } : {}) };
}

/**
 * The spawn half of `runOrca`, usable for other JSON CLIs: `name` labels errors,
 * `unwrap` turns the parsed stdout into a result.
 */
export function runJsonCli(name: string, bin: string, args: readonly string[], opts: OrcaOptions, unwrap: (parsed: unknown, code: number | null) => OrcaResult): Promise<OrcaResult> {
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, error: `${name} call cancelled` });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_OUTPUT_BYTES;
  if (containsSecret(args, opts.extraSecretPatterns)) return Promise.resolve({ ok: false, error: `refused: an argument looks like a credential; secrets never go on the ${name} command line` });
  const srcEnv = opts.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_PASSTHROUGH) if (srcEnv[k] !== undefined) env[k] = srcEnv[k];
  Object.assign(env, opts.extraEnv);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: OrcaResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Own process group: a wrapper script that does not `exec` leaves orca as a
      // grandchild, which only a group kill reaches. Windows has no process groups
      // of this kind and `detached` would open a console window there.
      child = spawn(bin, [...args, "--json"], { env, stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], shell: false, detached: !WINDOWS, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: `cannot run ${name}: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    if (opts.stdin !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(opts.stdin);
    }
    const pgid = child.pid;
    if (pgid !== undefined) liveGroups.add(pgid);
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = "";
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (WINDOWS || child.pid === undefined) child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch {
        child.kill(sig); // group already gone or never formed
      }
    };
    const kill = () => {
      signal("SIGTERM");
      // The leader may be gone while a descendant that ignored SIGTERM lives on.
      setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const abort = () => {
      kill();
      settle({ ok: false, error: `${name} call cancelled` });
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    const timer = setTimeout(() => {
      kill();
      // Not waiting for `close`: a descendant that ignores SIGTERM keeps the pipes open until SIGKILL.
      settle({ ok: false, error: `${name} ${args.slice(0, 2).join(" ")} timed out after ${formatTimeout(timeoutMs)}` });
    }, timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      if (truncated) return;
      if (size + d.length > maxBytes) {
        chunks.push(d.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        kill();
        return;
      }
      chunks.push(d);
      size += d.length;
    });
    // Keepalive lines and diagnostics; only a short tail is kept for error messages.
    child.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-2000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      if (pgid !== undefined) liveGroups.delete(pgid);
      settle({ ok: false, error: `cannot run ${name} (${bin}): ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      if (pgid !== undefined) liveGroups.delete(pgid);
      if (settled) return;
      const out = Buffer.concat(chunks).toString("utf8");
      if (truncated) {
        return settle({
          ok: false,
          truncated: true,
          error: `${name} output exceeded ${Math.round(maxBytes / 1024)} KB and was cut; narrow the request (limit, cursor). First part:\n${out.slice(0, 4000)}`,
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(out);
      } catch {
        const tail = (out.trim() || stderr.trim()).slice(-500);
        return settle({ ok: false, error: `${name} returned no JSON (exit ${code ?? "signal"})${tail ? `: ${tail}` : ""}` });
      }
      settle(unwrap(parsed, code));
    });
  });
}
