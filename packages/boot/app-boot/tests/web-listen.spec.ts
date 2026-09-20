/**
 * The Web listen record: one Harness process publishes its running Web service
 * so a second surface on the same home adopts it. These cases pin the
 * publication mode, the validation that keeps a stale or foreign file from
 * being trusted, and the liveness handshake that separates a live Harness
 * service from any other listener on the recorded port.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  clearWebListen, isProcessAlive, probeWebListen, publishWebListen, readWebListen,
  WEB_LISTEN_FILENAME, WEB_LISTEN_VERSION, webListenPath, type WebListenRecord,
} from '../src/index.ts'

const tempRoots: string[] = []
const servers: ReturnType<typeof createServer>[] = []

afterAll(async () => {
  for (const server of servers.splice(0)) server.close()
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One empty Harness home the record can be published into. */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-listen-'))
  tempRoots.push(dir)
  return dir
}

/** A listener that answers the token exchange a live Harness service answers. */
async function listening(status: number): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, status === 303 ? { location: '/' } : {})
    res.end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind a port')
  return `http://127.0.0.1:${String(address.port)}/?token=test`
}

/** One record naming a live listener. */
function recordFor(url: string): WebListenRecord {
  return { version: WEB_LISTEN_VERSION, pid: process.pid, port: Number(new URL(url).port), url, injections: [] }
}

describe('web listen record', () => {
  it('publishes an owner-only record that reads back whole', () => {
    const dir = home()
    const record: WebListenRecord = {
      version: WEB_LISTEN_VERSION,
      pid: 4242,
      port: 3080,
      url: 'http://127.0.0.1:3080/?token=abc',
      injections: [{ kind: 'global', name: 'agent', value: 'worker' }],
    }
    publishWebListen(dir, record)

    expect(webListenPath(dir)).toBe(join(dir, WEB_LISTEN_FILENAME))
    expect(readWebListen(dir)).toEqual(record)
    expect(statSync(webListenPath(dir)).mode & 0o777).toBe(0o600)
  })

  it('treats an unusable file as nothing published', () => {
    const dir = home()
    const path = webListenPath(dir)
    const valid: WebListenRecord = {
      version: WEB_LISTEN_VERSION, pid: 1, port: 3080, url: 'http://127.0.0.1:3080/?token=a', injections: [],
    }
    const unusable: [string, string][] = [
      ['truncated JSON', '{'],
      ['a JSON scalar', 'null'],
      ['another generation', JSON.stringify({ ...valid, version: 2 })],
      ['a non-object', JSON.stringify([])],
      ['a missing pid', JSON.stringify({ ...valid, pid: undefined })],
      ['a fractional port', JSON.stringify({ ...valid, port: 30.5 })],
      ['a port above the range', JSON.stringify({ ...valid, port: 70_000 })],
      ['an unparseable URL', JSON.stringify({ ...valid, url: 'not a url' })],
      ['a non-loopback URL', JSON.stringify({ ...valid, url: 'http://example.test:3080/?token=a' })],
      ['an https URL', JSON.stringify({ ...valid, url: 'https://127.0.0.1:3080/?token=a' })],
      ['injections that are not a list', JSON.stringify({ ...valid, injections: {} })],
    ]
    expect(readWebListen(dir)).toBeUndefined()
    for (const [label, value] of unusable) {
      writeFileSync(path, value)
      expect(readWebListen(dir), label).toBeUndefined()
    }
  })

  it('propagates a read failure that is not absence', () => {
    const dir = home()
    mkdirSync(webListenPath(dir))
    expect(() => readWebListen(dir)).toThrow(/EISDIR/u)
  })

  it('removes the record only while it belongs to the caller', () => {
    const dir = home()
    publishWebListen(dir, {
      version: WEB_LISTEN_VERSION, pid: process.pid + 1, port: 3080, url: 'http://127.0.0.1:3080/?token=a', injections: [],
    })
    clearWebListen(dir, process.pid)
    expect(readWebListen(dir)).toBeDefined()

    clearWebListen(dir, process.pid + 1)
    expect(readWebListen(dir)).toBeUndefined()
    clearWebListen(dir, process.pid + 1)
  })

  it('reports process liveness for this process and an exited one', async () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const exited = child.pid
    await once(child, 'exit')
    expect(exited).toBeDefined()
    expect(isProcessAlive(exited as number)).toBe(false)
  })

  it('adopts only a record whose owner answers the token exchange', async () => {
    const dir = home()
    expect(await probeWebListen(dir)).toBeUndefined()

    const live = recordFor(await listening(303))
    publishWebListen(dir, live)
    expect(await probeWebListen(dir)).toEqual(live)

    // A listener that is not this Harness service cannot pass as one.
    publishWebListen(dir, recordFor(await listening(200)))
    expect(await probeWebListen(dir)).toBeUndefined()

    // The owner is gone, so the record is stale however the port answers.
    const dead = spawn(process.execPath, ['-e', ''])
    await once(dead, 'exit')
    publishWebListen(dir, { ...recordFor(await listening(303)), pid: dead.pid as number })
    expect(await probeWebListen(dir)).toBeUndefined()
  })

  it('reports nothing when no service is listening on the recorded port', async () => {
    const dir = home()
    const server = createServer(() => {})
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind a port')
    const url = `http://127.0.0.1:${String(address.port)}/?token=test`
    publishWebListen(dir, recordFor(url))
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })

    expect(await probeWebListen(dir, 500)).toBeUndefined()
  })
})
