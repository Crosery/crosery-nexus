import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 发布身份：`scripts/release.mjs` 写进发布目录 RELEASE.json 的可公开字段（不含路径、主机、构建环境）。 */
export type PublicRelease = {
  env: string | null
  version: string | null
  tag: string | null
  commit: string | null
  releaseId: string | null
  createdAt: string | null
}

const FIELDS = ['env', 'version', 'tag', 'commit', 'releaseId', 'createdAt'] as const

let cached: PublicRelease | null = null

export function readPublicRelease(dir = process.cwd()): PublicRelease {
  const release = Object.fromEntries(FIELDS.map((field) => [field, null])) as PublicRelease
  try {
    const file = join(dir, 'RELEASE.json')
    if (!existsSync(file)) return release
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    for (const field of FIELDS) {
      const value = raw?.[field]
      if (typeof value === 'string' && value.length <= 200) release[field] = value
    }
  } catch {
    // RELEASE.json 损坏时按「没有发布身份」回答，发布脚本会因提交号对不上而判定失败
  }
  return release
}

/** 进程内只读一次：发布切换必然重启进程。 */
export function currentPublicRelease(): PublicRelease {
  cached ??= readPublicRelease()
  return cached
}
