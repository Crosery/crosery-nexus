/**
 * release-prune.mjs —— 组装 release 时，哪些「生产基底里有、仓库已删除」的文件不能带进新 release。
 *
 * 组装方式是「复制生产 release 作基底 + 叠加 git 跟踪文件」，并且 runbook §2.2 严禁 `--delete`（保护 data/、.env、
 * node_modules 与生产独有补丁）。代价是：仓库删掉的源码会作为孤儿留在新 release 里并进入 MANIFEST；可选的模式 V
 * （`npm ci && npm run build`）里 `tsc -b` 会编译 server/**\/*.ts，孤儿 import 的依赖已被 npm ci 移除时直接 TS2307。
 *
 * 规则（保守）：只删同时满足下面四条的路径——
 *   1. 在组装树里（来自生产基底）；
 *   2. 不在仓库当前的跟踪且存在的文件里；
 *   3. git 记录为删除（已提交的删除；`--allow-dirty` 演练时也算工作区里的删除）；
 *   4. 位于代码目录（server/ src/ scripts/ apps/ packages/）——孤儿会参与构建的地方。
 * 其余「git 删了但基底还有」的路径只列为警告，交给人工判断；运行态与密钥（data/、.env*、node_modules/ …）永不删除。
 */

export const PRUNE_ROOTS = ['server/', 'src/', 'scripts/', 'apps/', 'packages/']
export const NEVER_PRUNE = [/^data\//, /^node_modules\//, /(^|\/)\.env/, /^\.git\//, /^dist\//, /^MANIFEST\.sha256$/, /^RELEASE\.json$/]

/**
 * @param {{ assembled: Iterable<string>, kept: Iterable<string>, deleted: Iterable<string> }} input
 *   assembled = 组装树里的相对路径；kept = 仓库跟踪且存在的文件；deleted = git 记录为删除的路径
 * @returns {{ prune: string[], review: string[] }} prune = 自动删除；review = 只告警
 */
export function planPrune({ assembled, kept, deleted }) {
  const keep = new Set(kept)
  const gone = new Set(deleted)
  const prune = []
  const review = []
  for (const rel of new Set(assembled)) {
    if (!gone.has(rel) || keep.has(rel)) continue
    if (rel.split('/').includes('..') || NEVER_PRUNE.some((re) => re.test(rel))) continue
    if (PRUNE_ROOTS.some((root) => rel.startsWith(root))) prune.push(rel)
    else review.push(rel)
  }
  return { prune: prune.sort(), review: review.sort() }
}

/**
 * NUL 分隔的 git 路径输出（`-z`）→ 去重路径列表。路径原样保留（不 trim）：`server/a.ts ` 与 `server/a.ts`
 * 是两个文件，裁掉空白会让一次删除误删另一个从未删除的文件。只去掉个别 git 版本在提交之间插入的换行。
 */
export function splitZ(text) {
  return [...new Set(String(text || '').split('\0').map((entry) => entry.replace(/^\n+/, '')).filter(Boolean))]
}
