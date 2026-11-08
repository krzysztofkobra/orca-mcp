import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePrivateDir } from "./bridge.js";

/**
 * The per-user state dir: macOS `~/Library/Application Support/orca-mcp`, Windows
 * `%LOCALAPPDATA%\orca-mcp`, else `$XDG_STATE_HOME/orca-mcp` or `~/.local/state/orca-mcp`.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support", "orca-mcp");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "orca-mcp");
  return join(env.XDG_STATE_HOME?.trim() || join(home, ".local", "state"), "orca-mcp");
}

export type SavedCoordinator = { id: string; key: string };

export interface CoordinatorStore {
  load(): SavedCoordinator | undefined;
  save(c: SavedCoordinator): void;
}

const WINDOWS = process.platform === "win32";

/**
 * The external coordinator of one client tag, in `<stateDir>/external-coordinator-<tag>.json`
 * (dir 0700, file 0600). The key in it is a credential: a file this user does not own, or one
 * others could read, is never trusted, and every write lands whole (tmp file, then rename).
 */
export function fileCoordinatorStore(dir: string, tag: string, stat: typeof lstatSync = lstatSync): CoordinatorStore {
  const file = join(dir, `external-coordinator-${tag}.json`);
  const ready = () => {
    mkdirSync(dirname(dir), { recursive: true });
    if (WINDOWS) {
      mkdirSync(dir, { recursive: true });
      return true;
    }
    return "ok" in ensurePrivateDir(dir, stat);
  };
  return {
    load: () => {
      try {
        if (!WINDOWS) {
          const d = stat(dir);
          if (!d.isDirectory() || d.uid !== process.getuid?.() || d.mode & 0o077) return undefined;
          const st = stat(file);
          if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077) return undefined;
        }
        const v = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedCoordinator>;
        return typeof v.id === "string" && v.id && typeof v.key === "string" && v.key ? { id: v.id, key: v.key } : undefined;
      } catch {
        return undefined;
      }
    },
    save: (c) => {
      try {
        if (!ready()) return;
      } catch {
        return;
      }
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify({ id: c.id, key: c.key }), { mode: 0o600, flag: "w" });
        if (!WINDOWS) chmodSync(tmp, 0o600);
        renameSync(tmp, file);
      } catch {
        try {
          unlinkSync(tmp);
        } catch {
          // nothing written
        }
      }
    },
  };
}
