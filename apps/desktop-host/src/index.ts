/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { delimiter, join } from 'node:path'
import { loadLayeredEnv, loadProfileDirectory, probeWebListen, type WebListenRecord } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as desktopOffice from './office.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'

/**
 * Arguments owned by the Desktop-launched Web runner.
 *
 * The Host still adopts an already-published service for this Harness home
 * before it boots. When no adoptable sibling exists, let the Web server choose
 * a free loopback port instead of competing for the Web CLI's default 3080;
 * Electron uses the authenticated URL reported after boot.
 */
export function desktopHostWebArgs(): readonly string[] {
  return ['--no-open', '--port', '0']
}

/** The parent IPC channel this Host is spawned with; `process` in production. */
export interface DesktopHostChannel {
  readonly connected: boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'disconnect', listener: () => void): unknown
  send?(message: unknown, callback?: (error: Error | null) => void): boolean
  disconnect(): void
}

/**
 * Report the Web service this Harness home already publishes, then stay alive as
 * the backend handle Electron started.
 *
 * This process boots no Harness: the published service owns the session log, the
 * workspace, and every plugin row, so it is the one surface both the browser and
 * the desktop window talk to. Stopping this child therefore cannot stop that
 * service — nothing here is holding it.
 * @param record - the live service published on this Harness home.
 * @param channel - parent IPC channel to report over.
 * @returns completion once Electron disconnects this child.
 */
export async function adoptPublishedService(
  record: WebListenRecord,
  channel: DesktopHostChannel = process,
): Promise<void> {
  if (!channel.connected) return
  channel.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') channel.disconnect()
    // Answer task control rather than leave the update flow waiting: this child
    // owns no tasks, and the composer names the adopted service as the owner.
    if (message.type === 'update-tasks' && 'requestId' in message && Number.isSafeInteger(message.requestId)) {
      channel.send?.({ type: 'update-tasks', requestId: message.requestId, active: true,
        error: 'desktop update: the adopted Web service owns this session' }, (error) => { if (error !== null) console.error(error) })
    }
  })
  await new Promise<void>((resolve) => {
    channel.once('disconnect', resolve)
    channel.send?.({ type: 'ready', url: record.url, injections: record.injections, attached: true },
      (error) => { if (error !== null) console.error(error) })
  })
}

async function main(): Promise<void> {
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  const adopted = await probeWebListen(resolveDshHome())
  if (adopted !== undefined) {
    await adoptPublishedService(adopted)
    return
  }
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolutionMode: process.argv[5] === 'runtime' ? 'runtime' : 'link',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: desktopHostWebArgs(),
    ...(process.argv[6] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[6]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[7] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping: Promise<void> | undefined
  const control: { updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl> } = {}
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  await ctx.plugin(desktopOffice, {
    source: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  if (process.connected) process.send?.({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections() }, (error) => { if (error !== null) console.error(error) })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (process.connected) process.send?.({ type: 'fatal', message }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
