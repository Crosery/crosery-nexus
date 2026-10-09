import type express from 'express'
import { CPA_CATALOG } from './accountCatalog.js'

/**
 * /api/accounts — the accounts page's backend descriptor (ACCOUNTS-ALIGN §2.3). Accounts are CPA credentials: the
 * page uses the CPA endpoints (/api/channels, /api/monitor, /api/cpa/oauth/*, /api/credentials/*); these routes only
 * say so and list the CPA providers.
 * Admin only: key sessions are refused by the default-deny guard (server/auth.ts) before reaching these.
 */

export function createAccountsService() {
  return {
    async list() {
      return { backend: 'cpa' as const, available: true, reason: null, message: null, routing: true, providers: [], excluded: [], counts: null }
    },

    async catalog() {
      return { backend: 'cpa' as const, available: true, reason: null, items: CPA_CATALOG, copy: {} }
    },
  }
}

export type AccountsService = ReturnType<typeof createAccountsService>

let defaultService: AccountsService | null = null
/** The process-wide service (index.ts registers it). */
export function accountsService(): AccountsService {
  if (!defaultService) defaultService = createAccountsService()
  return defaultService
}

export function registerAccountsRoutes(app: express.Express, service: AccountsService): void {
  const handle = (run: () => Promise<unknown>) => async (_req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.json(await run())
    } catch {
      res.status(500).json({ error: '操作失败', code: 'internal_error' })
    }
  }

  app.get('/api/accounts', handle(() => service.list()))
  app.get('/api/accounts/catalog', handle(() => service.catalog()))
}
