/**
 * The launcher's adoption decision: one Harness home serves one Web runtime, so
 * `dsh web` adopts a published service instead of failing on an occupied port,
 * while an invocation that names its own bind target always serves its own.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { publishWebListen, WEB_LISTEN_VERSION } from '@deepseek-ai/dsh-app-boot'
import { adoptedWebService } from '../src/web-adopt.ts'

const homes: string[] = []
const servers: ReturnType<typeof createServer>[] = []

afterAll(async () => {
  for (const server of servers.splice(0)) server.close()
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-adopt-'))
  homes.push(dir)
  return dir
}

/** Publish one record naming a listener that answers the token exchange. */
async function publishLive(dir: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(303, { location: '/' })
    res.end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind a port')
  const url = `http://127.0.0.1:${String(address.port)}/?token=shared`
  publishWebListen(dir, { version: WEB_LISTEN_VERSION, pid: process.pid, port: address.port, url, injections: [] })
  return url
}

describe('adoptedWebService', () => {
  it('adopts the live service of this home for the web profile', async () => {
    const dir = home()
    expect(await adoptedWebService('web', [], dir)).toBeUndefined()
    const url = await publishLive(dir)
    expect(await adoptedWebService('web', ['--no-open'], dir)).toBe(url)
  })

  it('never redirects an invocation that names its own bind target', async () => {
    const dir = home()
    const url = await publishLive(dir)
    for (const args of [['--port', '8080'], ['--port=8080'], ['--host', '0.0.0.0'], ['--host=127.0.0.1']]) {
      expect(await adoptedWebService('web', args, dir), args.join(' ')).toBeUndefined()
    }
    // The url stays published: only this invocation declined to adopt it.
    expect(await adoptedWebService('web', [], dir)).toBe(url)
  })

  it('leaves every other profile to its own rows', async () => {
    const dir = home()
    await publishLive(dir)
    expect(await adoptedWebService('tui', [], dir)).toBeUndefined()
    expect(await adoptedWebService('desktop', ['--no-open'], dir)).toBeUndefined()
  })

  it('serves its own socket when the record outlived its service', async () => {
    const dir = home()
    publishWebListen(dir, {
      version: WEB_LISTEN_VERSION,
      // This process is alive but publishes no token exchange on that port.
      pid: process.pid,
      port: 1,
      url: 'http://127.0.0.1:1/?token=stale',
      injections: [],
    })
    expect(await adoptedWebService('web', [], dir)).toBeUndefined()
  })
})
