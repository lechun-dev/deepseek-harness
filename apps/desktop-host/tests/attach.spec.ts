/**
 * Desktop Host adoption: when this Harness home already publishes a live Web
 * service, the Host Electron spawned reports that service to its parent and
 * stays alive as an inert backend handle. These cases pin the ready payload
 * (which tells Electron the backend owns no tasks), the task-control answer
 * that keeps the update flow from waiting, and the wait that ends only when
 * Electron disconnects.
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { WEB_LISTEN_VERSION, type WebListenRecord } from '@deepseek-ai/dsh-app-boot'
import { adoptPublishedService, desktopHostWebArgs, type DesktopHostChannel } from '../src/index.ts'

const record: WebListenRecord = {
  version: WEB_LISTEN_VERSION,
  pid: 84690,
  port: 3080,
  url: 'http://127.0.0.1:3080/?token=shared',
  injections: [{ kind: 'global', name: 'agent', value: 'worker' }],
}

/** The parent channel Electron spawns this Host with, without a real socket. */
class FakeChannel extends EventEmitter implements DesktopHostChannel {
  readonly sent: unknown[] = []
  connected = true
  fail = false
  disconnect = vi.fn(() => { this.emit('disconnect') })

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(this.fail ? new Error('channel closed') : null)
    return !this.fail
  }
}

describe('adoptPublishedService', () => {
  it('reports the adopted service, refuses task control, and waits for disconnect', async () => {
    const channel = new FakeChannel()
    const adopted = adoptPublishedService(record, channel)
    await new Promise(resolve => setImmediate(resolve))
    expect(channel.sent).toEqual([{ type: 'ready', url: record.url, injections: record.injections, attached: true }])

    channel.emit('message', { type: 'update-tasks', requestId: 7, action: 'inspect' })
    expect(channel.sent[1]).toEqual({
      type: 'update-tasks', requestId: 7, active: true,
      error: 'desktop update: the adopted Web service owns this session',
    })

    let settled = false
    void adopted.then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)

    channel.emit('message', { type: 'shutdown' })
    await adopted
    expect(channel.disconnect).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated IPC traffic', async () => {
    const channel = new FakeChannel()
    const adopted = adoptPublishedService(record, channel)
    await new Promise(resolve => setImmediate(resolve))
    channel.emit('message', 'not-an-event')
    channel.emit('message', { type: 'update-tasks', requestId: 'seven' })
    channel.emit('message', { type: 'shutdown-complete' })
    expect(channel.sent).toHaveLength(1)
    channel.emit('message', { type: 'shutdown' })
    await adopted
  })

  it('reports nothing when the child has no parent', async () => {
    const channel = new FakeChannel()
    channel.connected = false
    await adoptPublishedService(record, channel)
    expect(channel.sent).toEqual([])
  })
})

describe('desktopHostWebArgs', () => {
  it('keeps the composed Web default while that port is free', async () => {
    expect(await desktopHostWebArgs(async port => port === 3080)).toEqual(['--no-open'])
  })

  it('falls back to an OS-assigned loopback port when the default is occupied', async () => {
    expect(await desktopHostWebArgs(async () => false)).toEqual(['--no-open', '--port', '0'])
  })
})
