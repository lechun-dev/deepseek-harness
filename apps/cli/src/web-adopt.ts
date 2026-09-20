/**
 * The launcher's Web-service adoption decision: one Harness home serves one Web
 * runtime, so an invocation that would bind a second socket on the same port
 * uses the service already published there instead.
 *
 * The decision cannot live in the Web app plugin: the webserver row binds while
 * it activates, so an occupied port fails that row's fiber and the Web app never
 * activates to notice the running sibling.
 * @module @deepseek-ai/dsh/web-adopt
 */

import { probeWebListen } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Profile whose rows serve the browser surface. */
const WEB_PROFILE = 'web'

/**
 * The URL of a running Web service this invocation adopts.
 * @param profile - the profile this invocation boots.
 * @param args - the invocation's inner arguments, owned by the booted tree.
 * @param home - Harness home holding the listen record; defaults to the resolved home.
 * @returns the live service URL, or undefined when this invocation serves its own socket.
 */
export async function adoptedWebService(
  profile: string,
  args: readonly string[],
  home: string = resolveDshHome(),
): Promise<string | undefined> {
  if (profile !== WEB_PROFILE) return undefined
  // --host and --port name the bind target that the Web app's own flag family
  // owns; an invocation asking for a socket of its own is never redirected.
  const namesBindTarget = args.some(arg =>
    ['--host', '--port'].some(flag => arg === flag || arg.startsWith(`${flag}=`)))
  if (namesBindTarget) return undefined
  return (await probeWebListen(home))?.url
}
