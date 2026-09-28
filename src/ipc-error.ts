/**
 * Electron re-wraps anything thrown inside `ipcMain.handle` as
 * `Error invoking remote method '<channel>': <ErrorName>: <message>` before it reaches the renderer.
 * Every message the main process writes for an operator — the write-permission preflight's, the store
 * guard's — therefore arrives behind a channel name that means nothing to them and pushes the
 * actionable half out of whatever narrow column it is rendered in.
 *
 * Its own module rather than a copy in each component: a second caller appeared the moment App started
 * showing a failed `getRepos()` in the same sidebar slot Sidebar writes into, and two regexes that must
 * agree about Electron's wrapper format are the kind of pair nothing here would catch drifting.
 */
export function readableIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const match = raw.match(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?(.*)$/s)
  return match ? match[1] : raw
}
