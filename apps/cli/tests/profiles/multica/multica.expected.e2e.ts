/** MissionOS JSONL interoperability through the shipped CLI and a private Harness home. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const bin = fileURLToPath(new URL('../../../lib/bin.js', import.meta.url))

it('discovers, streams, executes and resumes the bundled multica profile', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-multica-'))
  let server: Awaited<ReturnType<typeof startMockLlmServer>> | undefined
  try {
    server = await startMockLlmServer({ sequence: ['reasoning_success', 'reasoning_success', 'slow_success'], chunkDelayMs: 1000, chunkSize: 1, reasoningText: 'Checking', apiKey: 'multica-test', successText: 'MULTICA OK' })
    const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'multica-test', DSH_PERMISSION_MODE: 'danger-full-access' }
    const probe = await execa(process.execPath, [bin, '--profile', 'multica', '--probe'], { env, timeout: 60_000 })
    expect(JSON.parse(probe.stdout)).toEqual({ v: 1, type: 'probe', runtime: 'dsh', plugin_version: '0.1.0', protocol_version: 1 })
    expect(probe.stderr).toBe('')
    const models = await execa(process.execPath, [bin, '--profile', 'multica', '--list-models'], { env, timeout: 60_000 })
    const catalog = JSON.parse(models.stdout) as Record<string, unknown>
    expect(catalog).toMatchObject({ v: 1, type: 'models' })
    expect(Array.isArray(catalog.models)).toBe(true)
    const patch = join(home, 'profiles', 'multica', 'cordis.patch.yml')
    const customPatch = `- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  config:\n    baseURL: ${server.baseURL}\n`
    writeFileSync(patch, customPatch)
    let session: string | undefined
    for (const requestId of ['fresh', 'resume', 'cancel']) {
      const child = execa(process.execPath, [bin, '--profile', 'multica', '--stdio'], {
        env, reject: false, timeout: 60_000, killSignal: 'SIGKILL',
      })
      const lines = createInterface({ input: child.stdout })
      const frames: Record<string, unknown>[] = []
      try {
        for await (const line of lines) {
          const frame = JSON.parse(line) as Record<string, unknown>
          frames.push(frame)
          if (frame.type === 'ready') child.stdin.write(JSON.stringify({
            v: 1, type: 'execute', request_id: requestId, cwd: home, prompt: 'Say MULTICA OK',
            ...(requestId === 'resume' ? { resume_session_id: session } : {}),
          }) + '\n')
          if (frame.type === 'text' && requestId === 'cancel') child.stdin.write(JSON.stringify({
            v: 1, type: 'cancel', request_id: requestId,
          }) + '\n')
          if (frame.type === 'result') child.stdin.end()
        }
        const result = await child
        expect(result.timedOut, result.stderr).toBe(false)
        expect(result.exitCode, result.stderr).toBe(0)
        expect(frames).toContainEqual(expect.objectContaining({ type: 'result',
          request_id: requestId, status: requestId === 'cancel' ? 'cancelled' : 'completed',
        }))
        if (requestId !== 'cancel') {
          expect(frames.filter(frame => frame.type === 'text').map(frame => frame.content).join('')).toBe('MULTICA OK')
          expect(frames.filter(frame => frame.type === 'thinking').map(frame => frame.content).join('')).toBe('Checking')
          expect(frames).toContainEqual(expect.objectContaining({ type: 'usage', request_id: requestId }))
        }
        expect(frames.some(frame => frame.type === 'text' && typeof frame.content === 'string')).toBe(true)
        const opened = frames.find(frame => frame.type === 'session')!
        expect(opened.resumed).toBe(requestId === 'resume')
        expect(typeof opened.session_id).toBe('string')
        if (requestId === 'resume') expect(opened.session_id).toBe(session)
        session = String(opened.session_id)
      } finally {
        lines.close()
        child.kill('SIGKILL')
        await child
      }
    }
    expect(server.requests).toHaveLength(3)
    expect(readFileSync(patch, 'utf8')).toBe(customPatch)
  } finally {
    await server?.close()
    rmSync(home, { recursive: true, force: true })
  }
})
