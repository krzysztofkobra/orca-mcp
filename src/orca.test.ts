import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { containsSecret, formatTimeout, killAllOrcaChildren, MAC_ORCA_BIN, resolveOrcaBin, runOrca } from "./orca.js";
import { fakeOrca } from "./test/fake-orca.js";

describe("runOrca", () => {
  it("runs the binary with an argv array, --json appended, and a minimal env", async () => {
    const f = fakeOrca({ status: { stdout: { ok: true, result: { app: { running: true } } } } });
    const r = await runOrca(["status"], { bin: f.bin, env: f.env });
    expect(r).toEqual({ ok: true, result: { app: { running: true } } });
    const [c] = f.calls();
    expect(c!.argv).toEqual(["status", "--json"]);
    expect(c!.env).not.toContain("SECRET_TOKEN");
    expect(c!.env).not.toContain("ORCA_MCP_ROOTS");
    // A server started inside an Orca terminal must not act as that terminal.
    expect(c!.env).not.toContain("ORCA_TERMINAL_HANDLE");
  });

  it("does not run a shell: metacharacters reach orca as literal argv", async () => {
    const f = fakeOrca({});
    await runOrca(["search", "--query=$(touch pwned); `id` | cat"], { bin: f.bin, env: f.env });
    expect(f.calls()[0]!.argv).toEqual(["search", "--query=$(touch pwned); `id` | cat", "--json"]);
  });

  it("unwraps Orca's error envelope and reports non-JSON output", async () => {
    const f = fakeOrca({
      "repo show": { stdout: { ok: false, error: { code: "repo_not_found", message: "repo_not_found" } }, exit: 1 },
      "repo list": { raw: "Error: runtime not reachable", exit: 1 },
    });
    expect(await runOrca(["repo", "show"], { bin: f.bin, env: f.env })).toMatchObject({ ok: false, code: "repo_not_found", error: "orca error: repo_not_found" });
    const bad = await runOrca(["repo", "list"], { bin: f.bin, env: f.env });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/orca returned no JSON \(exit 1\): Error: runtime not reachable/);
  });

  it("caps stdout and says so", async () => {
    const f = fakeOrca({ "terminal read": { bytes: 3 * 1024 * 1024 } });
    const r = await runOrca(["terminal", "read"], { bin: f.bin, env: f.env, maxBytes: 1024 * 1024 });
    expect(r).toMatchObject({ ok: false, truncated: true });
    expect(!r.ok && r.error).toMatch(/exceeded 1024 KB and was cut/);
    expect(!r.ok && r.error.length).toBeLessThan(5000);
  });

  it("kills a call that outlives its timeout", async () => {
    const f = fakeOrca({ "terminal wait": { sleepMs: 5000 } });
    const t0 = Date.now();
    const r = await runOrca(["terminal", "wait"], { bin: f.bin, env: f.env, timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(!r.ok && r.error).toBe("orca terminal wait timed out after 300 ms");
  });

  it("kills the whole process group when a wrapper does not exec, without waiting for its pipes", async () => {
    const f = fakeOrca({});
    // A unique duration so pgrep finds only this test's sleep.
    const marker = `30.${process.pid}${Date.now() % 100000}`;
    const wrapper = join(f.home, "orca-wrapper");
    writeFileSync(wrapper, `#!/bin/sh\nsleep ${marker}\necho '{"ok":true,"result":{}}'\n`);
    chmodSync(wrapper, 0o755);
    const alive = () => spawnSync("pgrep", ["-f", `sleep ${marker}`]).status === 0;
    const t0 = Date.now();
    const r = await runOrca(["terminal", "wait"], { bin: wrapper, env: f.env, timeoutMs: 1500 });
    expect(Date.now() - t0).toBeLessThan(1500 + 2000);
    expect(!r.ok && r.error).toMatch(/timed out after 1500 ms$/);
    const deadline = Date.now() + 3000;
    while (alive() && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    expect(alive()).toBe(false);
  });

  it("reports the exact timeout: seconds when whole, else milliseconds", () => {
    expect(formatTimeout(30_000)).toBe("30 s");
    expect(formatTimeout(1500)).toBe("1500 ms");
  });

  it("killAllOrcaChildren signals the process group of every call in flight (shutdown)", async () => {
    const f = fakeOrca({});
    const marker = `31.${process.pid}${Date.now() % 100000}`;
    const wrapper = join(f.home, "orca-wrapper");
    writeFileSync(wrapper, `#!/bin/sh\nsleep ${marker}\necho '{"ok":true,"result":{}}'\n`);
    chmodSync(wrapper, 0o755);
    const alive = () => spawnSync("pgrep", ["-f", `sleep ${marker}`]).status === 0;
    const pending = runOrca(["terminal", "wait"], { bin: wrapper, env: f.env, timeoutMs: 60_000 });
    const deadline = Date.now() + 3000;
    while (!alive() && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));
    expect(alive()).toBe(true);
    expect(killAllOrcaChildren()).toBe(1);
    expect((await pending).ok).toBe(false);
    const gone = Date.now() + 3000;
    while (alive() && Date.now() < gone) await new Promise((res) => setTimeout(res, 50));
    expect(alive()).toBe(false);
    expect(killAllOrcaChildren()).toBe(0);
  });

  it("refuses credential-shaped arguments without running anything", async () => {
    const f = fakeOrca({});
    const r = await runOrca(["terminal", "send", "--text=export KEY=sk-ant-api03-abcdefghijklmnop"], { bin: f.bin, env: f.env });
    expect(r).toMatchObject({ ok: false });
    expect(() => f.calls()).toThrow(); // argv.log never written
    expect(containsSecret(["ghp_" + "a".repeat(36)])).toBe(true);
    expect(containsSecret(["plane_api_" + "a".repeat(20)])).toBe(false); // no product-specific shapes
    expect(containsSecret(["--spec=fix the sk- prefix parser"])).toBe(false);
  });

  it("stdin stays off argv and a cancelled call stops", async () => {
    const f = fakeOrca({ computer: { stdout: { ok: true, result: {} }, sleepMs: 2000 } });
    const controller = new AbortController();
    const pending = runOrca(["computer", "type-text", "--text-stdin"], { bin: f.bin, env: f.env, stdin: "Private text", signal: controller.signal });
    await vi.waitFor(() => expect(existsSync(join(f.home, "argv.log"))).toBe(true), { timeout: 1800 });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: "orca call cancelled" });
    expect(JSON.stringify(f.calls())).not.toContain("Private text");
  });
});

describe("resolveOrcaBin", () => {
  const none = () => false;
  it("prefers ORCA_BIN", () => {
    expect(resolveOrcaBin({ ORCA_BIN: "/opt/x/orca", HOME: "/h" }, "darwin", () => true)).toBe("/opt/x/orca");
  });
  it("uses the installed app CLI per platform, else orca from PATH", () => {
    expect(resolveOrcaBin({ HOME: "/h" }, "darwin", (p) => p === MAC_ORCA_BIN)).toBe(MAC_ORCA_BIN);
    expect(resolveOrcaBin({ HOME: "/h" }, "linux", (p) => p === "/h/.local/bin/orca")).toBe("/h/.local/bin/orca");
    expect(resolveOrcaBin({ HOME: "/h" }, "darwin", none)).toBe("orca");
    expect(resolveOrcaBin({ HOME: "/h" }, "linux", none)).toBe("orca");
    expect(resolveOrcaBin({ USERPROFILE: "C:\\Users\\k" }, "win32", none)).toBe("orca.exe");
  });
});
