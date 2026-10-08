/**
 * Test-only preload for the real console process:
 *   node --import tsx --import ./server/testing/routeTableDump.ts server/index.ts   (with ROUTE_TABLE_FILE set)
 * When index.ts calls `app.listen` every route is registered, so the preload writes the Express router stack —
 * including the routers mounted with `app.use('/api/me', router)` — to ROUTE_TABLE_FILE. Contract tests read the
 * routes the app really serves (conditional registrations included) instead of regex-parsing the sources.
 */
import fs from 'node:fs'
import express from 'express'

export type RouteTableEntry = { method: string; path: string }

type Layer = {
  route?: { path: string | string[]; methods: Record<string, boolean> }
  handle?: { stack?: Layer[] }
  mountPath?: string
}
type AppLike = { router: { stack: Layer[] } }

const join = (prefix: string, routePath: string) => {
  const joined = `${prefix.replace(/\/$/, '')}/${routePath.replace(/^\//, '')}`
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

function collect(stack: Layer[], prefix: string, out: RouteTableEntry[]) {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]
      const methods = Object.keys(layer.route.methods).filter(method => method !== '_all' && layer.route?.methods[method])
      for (const one of paths) for (const method of methods) out.push({ method: method.toUpperCase(), path: join(prefix, one) })
    } else if (layer.mountPath) {
      // a mounted router contributes its routes; a mounted plain middleware (the `/api` 404 fallthrough) is a mount
      if (Array.isArray(layer.handle?.stack)) collect(layer.handle.stack, join(prefix, layer.mountPath), out)
      else out.push({ method: 'USE', path: join(prefix, layer.mountPath) })
    }
  }
}

const application = express.application as unknown as {
  use: (this: AppLike, ...args: unknown[]) => unknown
  listen: (this: AppLike, ...args: unknown[]) => unknown
}
const originalUse = application.use
application.use = function use(this: AppLike, ...args: unknown[]) {
  const before = this.router.stack.length
  const result = originalUse.apply(this, args)
  if (typeof args[0] === 'string') for (const layer of this.router.stack.slice(before)) layer.mountPath = args[0]
  return result
}
const originalListen = application.listen
application.listen = function listen(this: AppLike, ...args: unknown[]) {
  const file = process.env.ROUTE_TABLE_FILE
  if (file) {
    const routes: RouteTableEntry[] = []
    collect(this.router.stack, '', routes)
    fs.writeFileSync(file, JSON.stringify(routes))
  }
  return originalListen.apply(this, args)
}
