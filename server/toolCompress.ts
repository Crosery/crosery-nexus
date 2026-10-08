/** Deterministic relay-side filtering of explicit text tool outputs, not structured results. */
export const MIN_COMPRESS_BYTES = 2048

const SGR_PATTERN = /\x1b\[(?:\d{1,3}(?:[;:]\d{0,3})*)?m/g
const PERCENT = '(?:100(?:\\.0+)?|(?:[0-9]|[1-9][0-9])(?:\\.[0-9]+)?)%'
const PROGRESS_LINE = new RegExp(`^[ \\t]*(?:${PERCENT}|\\[[ \\t]*${PERCENT}[ \\t]*\\])[ \\t]*$`)

export type CompressedText = { text: string; saved: number }

function progressFrames(line: string): number {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!text.includes('\r')) return PROGRESS_LINE.test(text) ? 1 : 0
  const frames = text.split('\r')
  return frames.every(frame => PROGRESS_LINE.test(frame)) ? frames.length : 0
}

/** Count summaries are barriers, so repeated processing cannot fold its own markers. */
export function compressToolText(raw: string): CompressedText {
  const rawBytes = Buffer.byteLength(raw, 'utf8')
  if (rawBytes < MIN_COMPRESS_BYTES) return { text: raw, saved: 0 }

  const uncolored = raw.replace(SGR_PATTERN, '')
  // Unknown or malformed escapes may contain payloads: leave all escapes intact in that block.
  const cleaned = uncolored.includes('\x1b') ? raw : uncolored
  const lines = cleaned.split('\n')
  const kept: string[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    if (line.startsWith('[RTK ')) {
      kept.push(line)
      index++
      continue
    }

    const start = index
    let count = progressFrames(line)
    const progress = count > 0
    if (!progress) count = 1
    let sourceBytes = Buffer.byteLength(line, 'utf8')
    index++
    while (index < lines.length) {
      const next = lines[index]!
      if (next.startsWith('[RTK ')) break
      const frames = progress ? progressFrames(next) : 0
      if (progress ? frames === 0 : next !== line) break
      count += progress ? frames : 1
      sourceBytes += 1 + Buffer.byteLength(next, 'utf8')
      index++
    }
    if (count < 3) {
      for (let cursor = start; cursor < index; cursor++) kept.push(lines[cursor]!)
      continue
    }

    const finalLine = lines[index - 1]!
    const suffix = finalLine.endsWith('\r') ? '\r' : ''
    const frameEnd = finalLine.length - suffix.length
    const last = progress
      ? finalLine.slice(finalLine.lastIndexOf('\r', frameEnd - 1) + 1, frameEnd) + suffix
      : line
    const marker = progress
      ? `[RTK numeric progress: ${count} updates]${suffix}`
      : `[RTK identical line: ${count} times]${suffix}`
    if (Buffer.byteLength(last, 'utf8') + 1 + Buffer.byteLength(marker, 'utf8') < sourceBytes) {
      kept.push(last, marker)
    } else {
      for (let cursor = start; cursor < index; cursor++) kept.push(lines[cursor]!)
    }
  }

  const text = kept.join('\n')
  const saved = rawBytes - Buffer.byteLength(text, 'utf8')
  return saved > 0 ? { text, saved } : { text: raw, saved: 0 }
}

type Walked = { saved: number }

function compressTextCarrier(value: unknown, textType: 'text' | 'input_text', walk: Walked): unknown {
  if (typeof value === 'string') {
    const done = compressToolText(value)
    walk.saved += done.saved
    return done.text
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      if (!part || typeof part !== 'object') continue
      const block = part as Record<string, unknown>
      if (block.type !== textType || typeof block.text !== 'string') continue
      const done = compressToolText(block.text)
      if (done.saved > 0) {
        block.text = done.text
        walk.saved += done.saved
      }
    }
  }
  return value
}

/** Walk full histories in place, retaining object identities, metadata and non-text parts. */
export function compressRequestToolOutputs(body: Record<string, unknown>): { body: Record<string, unknown>; saved: number } {
  const walk: Walked = { saved: 0 }
  const messages = body.messages
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      const entry = message as Record<string, unknown>
      if (entry.role === 'tool' || entry.role === 'function') {
        if ('content' in entry) entry.content = compressTextCarrier(entry.content, 'text', walk)
      } else if (entry.role === 'user' && Array.isArray(entry.content)) {
        for (const part of entry.content) {
          if (!part || typeof part !== 'object') continue
          const block = part as Record<string, unknown>
          if (block.type === 'tool_result' && 'content' in block) {
            block.content = compressTextCarrier(block.content, 'text', walk)
          }
        }
      }
    }
  }
  const input = body.input
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue
      const block = item as Record<string, unknown>
      if (block.type === 'function_call_output' && 'output' in block) {
        block.output = compressTextCarrier(block.output, 'input_text', walk)
      }
    }
  }
  return { body, saved: walk.saved }
}
