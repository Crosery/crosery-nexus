export type CredentialSummary = {
  name: string
  type: string
  disabled: boolean
  status: string
  label: string
  modelCount: number
  models: string[]
  proxyUrl: string
}

export function summarizeCredentialFiles(files: Array<Record<string, unknown>>): CredentialSummary[] {
  return files.map((file) => {
    const name = String(file.name || file.filename || '')
    return {
      name,
      type: String(file.type || file.provider || ''),
      disabled: Boolean(file.disabled),
      status: String(file.status || ''),
      label: String(file.email || file.account || '') || name.replace(/\.json$/i, ''),
      modelCount: 0,
      models: [],
      proxyUrl: typeof file.proxy_url === 'string' ? file.proxy_url.trim() : '',
    }
  }).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
}

/**
 * 凭据文件本身不带模型目录（网关 /auth-files 不返回 models），必须回网关按凭据查。
 * 同一 provider 下所有账号暴露的模型一致，因此按 type 取样合并即可——
 * 否则 400+ 个 xai 凭据会让每一轮同步打出几百个请求。
 */
export const OAUTH_MODEL_SAMPLES_PER_TYPE = 3

/**
 * 网关抖动、凭据刚换、注册表还没重建，都会让 /auth-files/models 临时返回空目录。
 * 空目录一旦当真往下传，这个 provider 的渠道组就是 0 个模型，一轮同步内所有挂着它的
 * Key 会被削成「无模型可用」——2026-08-20 GPT/Claude 全线 403 就是这个形态。
 * 所以只要该 provider 还有在线凭据，空结果一律退回上一次拿到的非空目录并记为降级。
 */
export function resolveProviderModels(
  fetched: Record<string, string[]>,
  lastKnown: Record<string, string[]>,
): { models: Record<string, string[]>; degraded: string[] } {
  const models: Record<string, string[]> = {}
  const degraded: string[] = []
  for (const [type, list] of Object.entries(fetched)) {
    const previous = lastKnown[type] || []
    if (list.length || !previous.length) {
      models[type] = list
      continue
    }
    models[type] = previous
    degraded.push(type)
  }
  return { models, degraded }
}

export type AttachCredentialModelsResult = {
  credentials: CredentialSummary[]
  models: Record<string, string[]>
  degraded: string[]
}

export async function attachCredentialModels(
  credentials: CredentialSummary[],
  fetchModels: (name: string) => Promise<string[]>,
  options: { samplesPerType?: number; lastKnown?: Record<string, string[]> } = {},
): Promise<AttachCredentialModelsResult> {
  const samplesPerType = options.samplesPerType ?? OAUTH_MODEL_SAMPLES_PER_TYPE
  const samples = new Map<string, string[]>()
  for (const credential of credentials) {
    if (!credential.type || credential.disabled) continue
    const picked = samples.get(credential.type) || []
    if (picked.length < samplesPerType) picked.push(credential.name)
    samples.set(credential.type, picked)
  }

  const fetched: Record<string, string[]> = {}
  await Promise.all([...samples].map(async ([type, names]) => {
    const lists = await Promise.all(names.map((name) => fetchModels(name)))
    fetched[type] = [...new Set(lists.flat())].sort()
  }))

  const { models, degraded } = resolveProviderModels(fetched, options.lastKnown || {})
  for (const credential of credentials) {
    const list = models[credential.type] || []
    credential.models = list
    credential.modelCount = list.length
  }
  return { credentials, models, degraded }
}
