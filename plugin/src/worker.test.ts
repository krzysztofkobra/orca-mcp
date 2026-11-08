// Fires Orca events at the worker as Orca would and reads what reaches a stand-in orca-mcp socket.
import { assert, mountWorker, test } from 'orca/testing'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'

async function listen(dir: string): Promise<{ server: Server; lines: string[] }> {
  const lines: string[] = []
  const server = createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(join(dir, '1.sock'), resolve))
  return { server, lines }
}

const until = async (cond: () => boolean) => {
  const end = Date.now() + 2000
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
}

const status = {
  workspaceId: 'r::/w/x',
  paneKey: 'tab:leaf',
  terminalId: 'term_1',
  state: 'waiting' as const,
  receivedAt: 1_700_000_000_000
}

test('forwards agent and workspace events as NDJSON to the orca-mcp socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asb-'))
  chmodSync(dir, 0o700)
  main.target.dir = dir
  const { server, lines } = await listen(dir)
  const worker = await mountWorker(main)
  try {
    await worker.emit('agent.status.changed', status)
    await worker.emit('workspace.created', { workspaceId: 'r::/w/y', kind: 'worktree', path: '/w/y', branch: 'b' })
    await until(() => lines.length >= 3)
    assert.deepEqual(
      lines.map((l) => JSON.parse(l).event),
      ['hello', 'agent.status.changed', 'workspace.created']
    )
    const sent = JSON.parse(lines[1]!)
    assert.equal(sent.v, 1)
    // Orca adds fields of its own (worktreeId); everything the event carried arrives unchanged.
    assert.deepEqual(Object.fromEntries(Object.keys(status).map((k) => [k, sent.payload[k]])), status)
  } finally {
    await worker.deactivate()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sends nothing into a socket dir other users can write to', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asb-'))
  chmodSync(dir, 0o777)
  main.target.dir = dir
  const { server, lines } = await listen(dir)
  const worker = await mountWorker(main)
  await worker.emit('agent.status.changed', status)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(lines.length, 0)
  await worker.deactivate()
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a server that is gone does not break the worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asb-'))
  chmodSync(dir, 0o700)
  main.target.dir = dir
  const { server } = await listen(dir)
  await new Promise<void>((r) => server.close(() => r()))
  const worker = await mountWorker(main)
  await worker.emit('agent.status.changed', status)
  await worker.emit('agent.status.changed', { ...status, state: 'done' })
  assert.deepEqual(worker.logs, [])
  await worker.deactivate()
  rmSync(dir, { recursive: true, force: true })
})
