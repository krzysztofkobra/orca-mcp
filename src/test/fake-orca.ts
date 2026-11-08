import { chmodSync, mkdirSync, mkdtempSync as mkdtempRaw, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { buildTools, type ToolDeps, type ToolResult } from "../tools.js";
import { runOrca, type OrcaResult } from "../orca.js";

const made: string[] = [];
export const mkdtempSync = (prefix: string) => {
  const d = mkdtempRaw(prefix);
  made.push(d);
  return d;
};
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

export type FakeReply = { stdout?: unknown; exit?: number; sleepMs?: number; bytes?: number; raw?: string };

/**
 * A fake `orca` binary. The runner passes only PATH/HOME/... to the child, so
 * the script finds its replies and log under $HOME: `responses.json` maps the
 * first two argv words (or the first) to a reply, and every call's argv and env
 * names are appended to `argv.log` as one JSON line.
 */
export function fakeOrca(responses: Record<string, FakeReply | FakeReply[]>) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "orca-mcp-fake-")));
  const bin = join(home, "orca");
  writeFileSync(join(home, "responses.json"), JSON.stringify(responses));
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("fs"), path = require("path");
const home = process.env.HOME;
const argv = process.argv.slice(2);
const coord = Object.fromEntries(["ORCA_EXTERNAL_COORDINATOR", "ORCA_EXTERNAL_COORDINATOR_KEY"].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
fs.appendFileSync(path.join(home, "argv.log"), JSON.stringify({ argv, env: Object.keys(process.env).sort(), coord }) + "\\n");
const r = JSON.parse(fs.readFileSync(path.join(home, "responses.json"), "utf8"));
const name = argv.slice(0, 2).join(" ");
let spec = r[name] ?? r[argv[0]] ?? { stdout: { ok: true, result: {} } };
// A list of replies is used in order, the last one repeating.
if (Array.isArray(spec)) {
  const counter = path.join(home, "count-" + name.replace(/\\W+/g, "_"));
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(n + 1));
  spec = spec[Math.min(n, spec.length - 1)];
}
const done = () => {
  if (spec.bytes) process.stdout.write("x".repeat(spec.bytes));
  else if (spec.raw !== undefined) process.stdout.write(spec.raw);
  else process.stdout.write(JSON.stringify(spec.stdout));
  process.exitCode = spec.exit ?? 0;
};
spec.sleepMs ? setTimeout(done, spec.sleepMs) : done();
`,
  );
  chmodSync(bin, 0o755);
  const devRoot = join(home, "dev");
  mkdirSync(join(devRoot, "repo"), { recursive: true });
  const env = { HOME: home, PATH: process.env.PATH, SECRET_TOKEN: "do-not-pass", ORCA_TERMINAL_HANDLE: "term_parent", ORCA_MCP_ROOTS: devRoot, ORCA_MCP_CLIENT: "tester" };
  const calls = () =>
    readFileSync(join(home, "argv.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; env: string[]; coord: Record<string, string> });
  const setReplies = (more: Record<string, FakeReply | FakeReply[]>) => writeFileSync(join(home, "responses.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, "responses.json"), "utf8")), ...more }));
  return { home, bin, env, devRoot, calls, setReplies };
}

type CallOut = { text: string; isError: boolean; state: string; summary: string; data: Record<string, unknown> };

async function invoke(list: ReturnType<typeof buildTools>, name: string, args: Record<string, unknown>): Promise<CallOut> {
  const t = list.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  const r = await (t.handler as (a: unknown) => Promise<ToolResult>)(args);
  return { text: r.content[0]!.text, isError: !!r.isError, state: r.structuredContent.state, summary: r.structuredContent.summary, data: r.structuredContent };
}

/** Tools wired to a fake binary. */
export function fakeTools(f: ReturnType<typeof fakeOrca>, opts: { orchestration?: boolean; caps?: string[]; envExtra?: Record<string, string>; deps?: Partial<ToolDeps> } = {}) {
  const env = { ...f.env, ...opts.envExtra };
  const list = buildTools({
    orchestration: async () => opts.orchestration ?? false,
    capabilities: async () => new Set(opts.caps ?? []),
    env,
    run: (args, o) => runOrca(args, { ...o, bin: f.bin, env }),
    ...opts.deps,
  });
  return { call: (name: string, args: Record<string, unknown>) => invoke(list, name, args) };
}

/** Orca replies by the first two argv words, in order; the last reply of each repeats. A clock that sleeps instantly. */
export function scripted(replies: Record<string, OrcaResult[]>, opts: { orchestration?: boolean; caps?: string[]; deps?: Partial<ToolDeps> } = {}) {
  const calls: string[][] = [];
  const queues = new Map(Object.entries(replies).map(([k, v]) => [k, [...v]]));
  let t = 1_000_000;
  const key = (args: string[]) => args.slice(0, 2).join(" ");
  const list = buildTools({
    orchestration: async () => opts.orchestration ?? false,
    capabilities: async () => new Set(opts.caps ?? []),
    env: { HOME: "/nowhere", ORCA_MCP_ROOTS: "/nowhere", ORCA_MCP_CLIENT: "tester" },
    run: async (args) => {
      calls.push(args);
      const q = queues.get(key(args));
      return (q && q.length > 1 ? q.shift() : q?.[0]) ?? { ok: true, result: {} };
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    pollMs: 5000,
    coordinatorStore: null,
    ...opts.deps,
  });
  return {
    call: (name: string, args: Record<string, unknown>) => invoke(list, name, args),
    calls,
    kinds: () => calls.map((c) => key(c)),
    at: (ms: number) => (t = ms),
  };
}
