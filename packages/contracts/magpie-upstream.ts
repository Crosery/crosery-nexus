export type MagpieUpstreamStatus = {
  status: 'not_checked' | 'unchanged' | 'review_required' | 'error' | 'baseline_mismatch'
  contractRevision: string
  candidateRevision: string | null
  checkedAt: string | null
  latestRelease: string | null
  rtkRelease: string | null
  routes: { inference: number; management: number; rtk: number }
  loginAgents: string[]
  changes: {
    addedRoutes: string[]
    removedRoutes: string[]
    changedRoutes: string[]
    schemaCount: number
    implementationFileCount: number
    addedLoginAgents: string[]
    removedLoginAgents: string[]
  }
  oauthConnected: false
  rtkConnected: false
}
