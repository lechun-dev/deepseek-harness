/** Validate MissionOS discovery and JSONL startup in the materialized CLI, including ASAR paths. */
import { execFile } from 'node:child_process'
import { join } from 'node:path'

/**
 * Launch the bundled CLI without model credentials and require protocol-v1 discovery and error handling.
 * @param root - Materialized dsh resource directory or app.asar/dsh.
 * @param node - Target Electron executable, running in Node mode through environment.
 * @param environment - Isolated Harness home and target runtime environment.
 * @returns Resolves when discovery, model listing and stdio validation pass.
 */
export async function smokeMulticaProfile(root: string, node: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  for (const mode of ['--probe', '--list-models', '--stdio']) {
    const frames = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const child = execFile(node, ['--expose-internals', bin, '--profile', 'multica', mode], {
        env: environment, timeout: 60_000, killSignal: 'SIGKILL', windowsHide: true,
      }, (error, stdout, stderr) => {
        const expectedExit = mode === '--stdio' ? 1 : 0
        const actualExit = error === null ? 0 : error.code
        if (actualExit !== expectedExit || error?.killed === true || error?.signal) {
          reject(error ?? new Error(`desktop multica: expected exit ${expectedExit}, received ${actualExit}`))
          return
        }
        if (stderr.trim() !== '') { reject(new Error(`desktop multica: ${stderr}`)); return }
        try {
          resolve(stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>))
        } catch (parseError) { reject(parseError) }
      })
      child.stdin?.end(mode === '--stdio' ? '{"v":1,"type":"invalid"}\n' : '')
    })
    const first = frames[0]
    if (first?.v !== 1) throw new Error(`desktop multica: missing v1 frame for ${mode}`)
    if (mode === '--probe' && (frames.length !== 1 || first.type !== 'probe' || first.runtime !== 'dsh'
      || first.protocol_version !== 1 || first.plugin_version !== '0.1.0')) {
      throw new Error('desktop multica: invalid discovery frame')
    }
    if (mode === '--list-models' && (frames.length !== 1 || first.type !== 'models'
      || !Array.isArray(first.models) || first.models.length === 0)) {
      throw new Error('desktop multica: missing model catalog')
    }
    if (mode === '--stdio' && (first.type !== 'ready'
      || !frames.some(frame => frame.type === 'protocol_error' && frame.code === 'INVALID_REQUEST'))) {
      throw new Error('desktop multica: JSONL startup or request validation failed')
    }
  }
}
