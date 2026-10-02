/**
 * Model kind as the server classifies it (server/modelKind.ts): by what the model OUTPUTS, so a chat model that
 * reads images is still 对话. A server that predates the field sends no kind — callers treat that as unknown
 * (no tag, no type filter) rather than guessing on the client.
 */
export type ModelKind = 'chat' | 'image' | 'video' | 'audio' | 'embedding' | 'rerank' | 'other'

export const MODEL_KINDS: readonly ModelKind[] = ['chat', 'image', 'video', 'audio', 'embedding', 'rerank', 'other']

export const MODEL_KIND_LABEL: Record<ModelKind, string> = {
  chat: '对话', image: '图片', video: '视频', audio: '语音', embedding: '向量', rerank: '重排', other: '其他',
}

export const isModelKind = (value: unknown): value is ModelKind => typeof value === 'string' && (MODEL_KINDS as readonly string[]).includes(value)

/**
 * The quiet tag next to an id: every kind except 对话 (the default needs no label). `selected` = the active type
 * filter: once the list is narrowed to one kind every row would carry the same tag, so none does.
 */
export const kindTag = (kind: ModelKind | null | undefined, selected: ModelKind | '' = ''): string | null =>
  (kind && kind !== 'chat' && !selected ? MODEL_KIND_LABEL[kind] : null)

export type KindChip = { value: string; label: string; count?: number | null }

/**
 * Type chips: `全部类型` (not `全部`: it sits next to the view chips' own `全部`) + every kind that occurs in `all`
 * (fixed order), each counted over `shown` (the list under the other filters; null = not loaded → no counts).
 * The selected kind stays even when absent so the applied filter is visible. null when there is nothing to tell
 * apart (≤1 kind and no selection).
 */
export function kindChips(
  all: Iterable<ModelKind | null | undefined>,
  shown: Iterable<ModelKind | null | undefined> | null,
  selected: ModelKind | '',
): KindChip[] | null {
  const present = new Set<ModelKind>()
  for (const kind of all) if (kind) present.add(kind)
  if (selected) present.add(selected)
  if (present.size < 2 && !selected) return null
  const counts = new Map<ModelKind, number>()
  if (shown) for (const kind of shown) if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return [
    { value: '', label: '全部类型' },
    ...MODEL_KINDS.filter((kind) => present.has(kind)).map((kind) => ({ value: kind, label: MODEL_KIND_LABEL[kind], count: shown ? counts.get(kind) ?? 0 : null })),
  ]
}
