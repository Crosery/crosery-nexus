import type { RouteLocation, RouteRecordRedirectOption } from 'vue-router'

/**
 * Redirect for a v2 path whose target carries its own query (`/providers?tab=channels`). vue-router lets a
 * string target's query replace the incoming one, so `/channels?q=x` and `/accounts?add=1` would land without
 * `q` / `add`; this keeps the incoming query and hash, the target's own keys win. Dependency-free so
 * `server/navRoutes.test.ts` can run it.
 */
export function carry(target: string): RouteRecordRedirectOption {
  const [path, search = ''] = target.split('?')
  const fixed = Object.fromEntries(new URLSearchParams(search))
  return (to: RouteLocation) => ({ path, query: { ...to.query, ...fixed }, hash: to.hash })
}
