// Forwards Orca's agent and workspace events, one NDJSON line each, to every orca-mcp server of
// this user (each listens on its own socket in a private per-user dir). Orca transpiles this file
// when it loads: no build step.
import type { OrcaWorkerApi } from 'orca/worker'
import { lstatSync, readdirSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EVENTS = ['agent.status.changed', 'workspace.created', 'workspace.removed'] as const
// Off on Windows: the named pipe namespace is shared by every user, so another user could
// create a matching pipe first and receive the events. orca-mcp polls there.
const SUPPORTED = process.platform !== 'win32'
// The server drops longer lines; skipping them here saves the write.
const MAX_LINE_BYTES = 64 * 1024
const VERSION = '0.1.0'

const uid = () => process.getuid?.() ?? -1

/** Where orca-mcp servers listen (must match orca-mcp's bridgeDir); tests point it elsewhere. */
export const target = { dir: join(tmpdir(), `orca-mcp-${uid()}`) }

function sockets(): string[] {
  if (!SUPPORTED) return []
  try {
    const st = lstatSync(target.dir)
    // Only our own private dir: events never go to sockets another user could have planted.
    if (!st.isDirectory() || st.uid !== uid() || st.mode & 0o077) return []
    return readdirSync(target.dir)
      .filter((n) => n.endsWith('.sock'))
      .map((n) => join(target.dir, n))
  } catch {
    return []
  }
}

const open = new Map<string, Socket>()

function send(line: string): void {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return
  for (const path of sockets()) {
    let sock = open.get(path)
    if (!sock || sock.destroyed) {
      const s = connect(path)
      // A server that exited leaves no listener (or a stale file): drop it, retry on the next event.
      s.on('error', () => s.destroy())
      s.on('close', () => {
        if (open.get(path) === s) open.delete(path)
      })
      s.write(`${JSON.stringify({ v: 1, event: 'hello', payload: { plugin: 'agent-status-bridge', version: VERSION } })}\n`)
      open.set(path, s)
      sock = s
    }
    sock.write(line)
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  for (const event of EVENTS) {
    orca.events.on(event, (payload: unknown) => send(`${JSON.stringify({ v: 1, event, payload })}\n`))
  }
}

export function deactivate(): void {
  for (const sock of open.values()) sock.end()
  open.clear()
}
