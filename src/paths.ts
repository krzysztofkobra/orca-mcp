import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Roots Orca may touch through this server: `ORCA_MCP_ROOTS` (separated by the
 * platform path delimiter, `:` or `;`), else `~/dev`.
 */
export function orcaRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const listed = env.ORCA_MCP_ROOTS?.split(delimiter).map((r) => r.trim()).filter(Boolean);
  const roots = listed?.length ? listed : [join(home, "dev")];
  return roots.filter((r) => isAbsolute(r));
}

/** `ORCA_MCP_TMP_PREFIX` (e.g. `orca-mcp-`): scratch dirs directly under the temp root with that name prefix are allowed too. */
const tmpPrefix = (env: NodeJS.ProcessEnv) => env.ORCA_MCP_TMP_PREFIX?.trim() || undefined;

/** realpath of the deepest existing ancestor plus the missing tail, so a symlinked parent is resolved too. */
function realish(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return p;
      tail.push(basename(head));
      head = up;
    }
  }
}

export const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function isScratchTmp(real: string, prefix: string): boolean {
  const tmpRoots = new Set(["/tmp", "/private/tmp", tmpdir()].map((t) => realish(t)));
  for (const t of tmpRoots) {
    if (!within(real, t) || real === t) continue;
    const first = relative(t, real).split(sep)[0] ?? "";
    if (first.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * The real absolute path when `raw` lies inside an allowed root, else an
 * error message. Lexical `..` and symlinks are resolved before the check, so
 * neither can step out of a root. Roots themselves are compared by realpath too.
 */
export function checkPath(raw: unknown, env: NodeJS.ProcessEnv = process.env): { path: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "path must be a non-empty string" };
  const v = raw.trim();
  if (v.includes("\0")) return { error: "path contains a NUL byte" };
  if (!isAbsolute(v)) return { error: "path must be absolute" };
  if (v.length > 1024) return { error: "path is too long" };
  const real = realish(resolve(v));
  const roots = orcaRoots(env).map((r) => realish(resolve(r)));
  const prefix = tmpPrefix(env);
  if (roots.some((r) => within(real, r) && real !== r) || (prefix && isScratchTmp(real, prefix))) return { path: real };
  return { error: `path ${v} is outside the allowed roots (${roots.join(", ")}${prefix ? `, <tmp>/${prefix}*` : ""}); set ORCA_MCP_ROOTS to change them` };
}
