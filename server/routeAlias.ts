/**
 * 中转层定向用的模型名 `rt-…/模型`（modelRoutes.ts 的 routePrefix / accountPrefix）：网关把带 prefix 的渠道和账号也这样列出来，
 * 它们只是同一来源的入口，不是另一个模型——不进分组、不进模型目录、不给客户端列出。
 */
export const ROUTE_ALIAS = /^rt-[a-z0-9-]+\//
