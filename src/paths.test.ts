import { chmodSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPath, isScratchTmp, orcaRoots } from "./paths.js";
import { fakeOrca, mkdtempSync } from "./test/fake-orca.js";

describe("path allowlist", () => {
  it("accepts paths under the roots and rejects everything else, symlinks and .. included", () => {
    const f = fakeOrca({});
    const env = f.env;
    expect(checkPath(join(f.devRoot, "repo"), env)).toEqual({ path: join(f.devRoot, "repo") });
    expect(checkPath(f.devRoot, env)).toHaveProperty("error"); // the root itself is not a repo
    expect(checkPath("/etc", env)).toHaveProperty("error");
    expect(checkPath(join(f.devRoot, "..", "responses.json"), env)).toHaveProperty("error");
    expect(checkPath("dev/repo", env)).toHaveProperty("error"); // relative
    expect(checkPath(`${f.devRoot}/repo\0x`, env)).toHaveProperty("error");
    symlinkSync(f.home, join(f.devRoot, "escape"));
    expect(checkPath(join(f.devRoot, "escape", "orca"), env)).toHaveProperty("error");
  });

  it("defaults to ~/dev and takes ORCA_MCP_ROOTS as a delimited list", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "orca-mcp-roots-")));
    mkdirSync(join(home, "dev", "a"), { recursive: true });
    mkdirSync(join(home, "work", "b"), { recursive: true });
    mkdirSync(join(home, "code", "c"), { recursive: true });
    expect(orcaRoots({ HOME: home })).toEqual([join(home, "dev")]);
    expect(checkPath(join(home, "dev", "a"), { HOME: home })).toHaveProperty("path");
    expect(checkPath(join(home, "work", "b"), { HOME: home })).toHaveProperty("error");
    const env = { HOME: home, ORCA_MCP_ROOTS: `${join(home, "work")}:${join(home, "code")}:relative/ignored` };
    expect(orcaRoots(env)).toEqual([join(home, "work"), join(home, "code")]);
    expect(checkPath(join(home, "work", "b"), env)).toHaveProperty("path");
    expect(checkPath(join(home, "code", "c"), env)).toHaveProperty("path");
    expect(checkPath(join(home, "dev", "a"), env)).toHaveProperty("error");
  });

  it("allows scratch dirs under the per-user temp root only with ORCA_MCP_TMP_PREFIX, and only with that prefix", () => {
    const env = { HOME: "/nowhere", ORCA_MCP_TMP_PREFIX: "orca-mcp-" };
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "orca-mcp-scratch-")));
    mkdirSync(join(dir, "repo"));
    expect(checkPath(dir, { HOME: "/nowhere" })).toHaveProperty("error");
    expect(checkPath(dir, env)).toEqual({ path: dir });
    expect(checkPath(join(dir, "repo"), env)).toEqual({ path: join(dir, "repo") });
    expect(checkPath(join(tmpdir(), "other-dir"), env)).toHaveProperty("error");
    expect(checkPath(tmpdir(), env)).toHaveProperty("error");
    expect(checkPath(join(tmpdir(), "orca-mcp-not-created"), env)).toHaveProperty("error");
  });

  it("refuses a scratch dir another user could have planted: shared /tmp, group/other writable, or not ours", () => {
    const env = { HOME: "/nowhere", ORCA_MCP_TMP_PREFIX: "orca-mcp-" };
    if (realpathSync(tmpdir()) !== realpathSync("/tmp")) {
      const shared = mkdtempSync("/tmp/orca-mcp-shared-");
      expect(checkPath(shared, env)).toHaveProperty("error");
    }
    const open = realpathSync(mkdtempSync(join(tmpdir(), "orca-mcp-open-")));
    chmodSync(open, 0o777);
    expect(checkPath(open, env)).toHaveProperty("error");
    expect(checkPath(join(open, "repo"), env)).toHaveProperty("error");
    const mine = realpathSync(mkdtempSync(join(tmpdir(), "orca-mcp-mine-")));
    expect(isScratchTmp(mine, "orca-mcp-")).toBe(true);
    const foreign = ((p: string) => ({ ...lstatSync(p), isDirectory: () => true, uid: (process.getuid?.() ?? 0) + 1, mode: 0o40700 })) as unknown as typeof lstatSync;
    expect(isScratchTmp(mine, "orca-mcp-", foreign)).toBe(false);
  });
});
