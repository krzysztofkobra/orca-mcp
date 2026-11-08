import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPath, orcaRoots } from "./paths.js";
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

  it("allows scratch dirs under the temp root only with ORCA_MCP_TMP_PREFIX, and only with that prefix", () => {
    const dir = mkdtempSync("/tmp/orca-mcp-scratch-");
    expect(checkPath(dir, { HOME: "/nowhere" })).toHaveProperty("error");
    expect(checkPath(dir, { HOME: "/nowhere", ORCA_MCP_TMP_PREFIX: "orca-mcp-" })).toEqual({ path: realpathSync(dir) });
    expect(checkPath("/tmp/other-dir", { HOME: "/nowhere", ORCA_MCP_TMP_PREFIX: "orca-mcp-" })).toHaveProperty("error");
    expect(checkPath("/tmp", { HOME: "/nowhere", ORCA_MCP_TMP_PREFIX: "orca-mcp-" })).toHaveProperty("error");
  });
});
