/**
 * The shared Web listen record: the handshake a Harness process publishes so
 * another surface on the same Harness home adopts its running Web service
 * instead of binding a second one.
 *
 * The record lives at `<home>/web-listen.json`, mode 0600. It carries the
 * authenticated root URL — whose launch token is the publishing process's only
 * authentication input — and the index injections a browser shell needs, so a
 * reader adopts the service with no message channel to it.
 *
 * This module imports nothing but Node builtins: the Desktop main process
 * bundles it through the package's `./web-listen` subpath, and must not pull
 * the boot graph in with it.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File name of the listen record inside the Harness home. */
export const WEB_LISTEN_FILENAME = 'web-listen.json'

/** Record generation this module writes and accepts; any other value is not ours. */
export const WEB_LISTEN_VERSION = 1

/** One published Web service, as read back from the record file. */
export interface WebListenRecord {
  /** Record generation; {@link WEB_LISTEN_VERSION} for every record this module accepts. */
  readonly version: typeof WEB_LISTEN_VERSION
  /** Process that bound the socket and wrote the record. */
  readonly pid: number
  /** Bound port, which is the OS-assigned value when the invocation asked for port 0. */
  readonly port: number
  /** Authenticated loopback root URL, token included. */
  readonly url: string
  /** Index injection rows the publishing service would serve, sampled once at publication. */
  readonly injections: readonly unknown[]
}

/**
 * Absolute path of the listen record for one Harness home.
 * @param home - Harness home holding the record.
 * @returns the record path inside that home.
 */
export function webListenPath(home: string): string {
  return join(home, WEB_LISTEN_FILENAME)
}

/**
 * Read one record, treating every unusable file as "nothing published".
 * A truncated write, a record from another generation, or a hand-edited file
 * is a stale handshake rather than a misconfiguration: the reader's answer is
 * the same as for a missing file, and the next publisher replaces it.
 * @param home - Harness home holding the record.
 * @returns the validated record, or undefined when there is none to trust.
 */
export function readWebListen(home: string): WebListenRecord | undefined {
  let text: string
  try {
    text = readFileSync(webListenPath(home), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const candidate = parsed as Record<string, unknown>
  if (candidate.version !== WEB_LISTEN_VERSION) return undefined
  const { pid, port, url, injections } = candidate
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined
  if (!Number.isSafeInteger(port) || (port as number) <= 0 || (port as number) > 65535) return undefined
  if (typeof url !== 'string' || !isLoopbackUrl(url)) return undefined
  if (!Array.isArray(injections)) return undefined
  return {
    version: WEB_LISTEN_VERSION,
    pid: pid as number,
    port: port as number,
    url,
    injections,
  }
}

/**
 * Publish one record, replacing any previous one atomically: a concurrent
 * reader sees either the previous record or this one, never a partial file.
 * @param home - Harness home that owns the record; created when missing.
 * @param record - the listening service's pid, port, authenticated URL, and injection snapshot.
 */
export function publishWebListen(home: string, record: WebListenRecord): void {
  const path = webListenPath(home)
  // The temporary name is process-unique so two publishers cannot interleave.
  const temporary = `${path}.${String(process.pid)}.tmp`
  mkdirSync(home, { recursive: true })
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Remove the record when it is this process's own.
 * The check is best-effort against a publisher racing the same path: losing
 * that race would remove a record whose owner is still serving, which the next
 * probe of that service repairs by publishing again.
 * @param home - Harness home holding the record.
 * @param pid - process that removes the record; a record naming anyone else stays.
 */
export function clearWebListen(home: string, pid: number): void {
  if (readWebListen(home)?.pid !== pid) return
  // Absence is the ordinary case (the file was already removed); every other
  // removal failure is a real filesystem problem and stays loud.
  rmSync(webListenPath(home), { force: true })
}

/**
 * Whether a process id is currently in use.
 * A live process owned by another user answers EPERM, which still proves it exists.
 * @param pid - process id to test.
 * @returns true when the process exists.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

/**
 * Whether this home has a published Web service that is still serving.
 *
 * Liveness is the record's own handshake, not a bare TCP connect: the
 * authenticated root URL is expected to answer the 303 that exchanges its
 * launch token for a browser cookie, so a foreign listener squatting on the
 * recorded port cannot pass as a Harness service.
 * @param home - Harness home holding the record.
 * @param timeoutMs - bound on the liveness request.
 * @returns the live record, or undefined when nothing is serving.
 */
export async function probeWebListen(home: string, timeoutMs = 1000): Promise<WebListenRecord | undefined> {
  const record = readWebListen(home)
  if (record === undefined) return undefined
  if (!isProcessAlive(record.pid)) return undefined
  try {
    const response = await fetch(record.url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    await response.body?.cancel()
    return response.status === 303 ? record : undefined
  } catch {
    // A refused connection or an expired deadline means the record outlived its
    // service; both are ordinary stale-handshake outcomes for the caller.
    return undefined
  }
}

/** Whether a recorded URL names this machine's loopback over plain HTTP. */
function isLoopbackUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
}
