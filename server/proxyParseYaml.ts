/**
 * The YAML subset that Clash/mihomo profiles use, with no dependency (PROXY-SPEC §2).
 *
 * Supported: block and flow mappings/sequences, plain/single/double-quoted scalars (multi-line too), comments,
 * literal/folded block scalars, anchors, aliases and `<<:` merge keys. Rejected: multi-document input and tags.
 *
 * Every scalar stays a string (null for `~`/`null`/empty): the caller coerces per field, so `password: 123456`
 * and `short-id: 0123` survive. Limits guard against hostile input: depth, node count after alias expansion
 * (alias bombs), input size. Heavy top-level sections a proxy import never needs (`rules`, `proxy-groups`…)
 * are skipped without parsing, so a 20k-rule profile does not hit the node limit.
 */

export type YamlValue = string | null | YamlValue[] | YamlMap
export type YamlMap = { [key: string]: YamlValue }

export class YamlSubsetError extends Error {
  constructor(message: string, readonly line: number | null = null) {
    super(line ? `第 ${line} 行：${message}` : message)
    this.name = 'YamlSubsetError'
  }
}

export type YamlParseOptions = {
  maxDepth?: number
  maxNodes?: number
  maxBytes?: number
  /** top-level keys whose content is skipped unparsed */
  skipKeys?: ReadonlySet<string>
  /** top-level keys that must parse; any other section that fails to parse is skipped instead of failing the input */
  requiredKeys?: ReadonlySet<string>
}

export type YamlParseResult = { value: YamlValue; topLevelKeys: string[]; skipped: string[] }

export const YAML_LIMITS = { maxDepth: 32, maxNodes: 10_000, maxBytes: 4 * 1024 * 1024 } as const

export const CLASH_SKIP_SECTIONS: ReadonlySet<string> = new Set([
  'rules', 'rule-providers', 'sub-rules', 'proxy-groups', 'hosts', 'dns', 'tun', 'sniffer', 'script',
  'listeners', 'tunnels', 'ntp', 'experimental', 'geox-url', 'profile', 'iptables', 'ebpf', 'authentication',
  'skip-auth-prefixes', 'lan-allowed-ips', 'lan-disallowed-ips',
])

type Line = { indent: number; text: string; raw: string; no: number }

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const newMap = (): YamlMap => Object.create(null) as YamlMap

const isBlank = (line: Line) => line.text === '' || line.text.startsWith('#')
const isSeqEntry = (text: string) => text === '-' || text.startsWith('- ') || text.startsWith('-\t')

const NULLS = new Set(['~', 'null', 'Null', 'NULL'])

function plainScalar(text: string): string | null {
  const value = text.trim()
  if (!value || NULLS.has(value)) return null
  return value
}

/** Index of a `#` that starts a comment in a plain (unquoted) block value, or -1. */
function plainCommentAt(text: string): number {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '#' && (index === 0 || text[index - 1] === ' ' || text[index - 1] === '\t')) return index
  }
  return -1
}

const stripPlainComment = (text: string) => {
  const at = plainCommentAt(text)
  return (at < 0 ? text : text.slice(0, at)).trimEnd()
}

const DOUBLE_ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ',
  '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: ' ', L: ' ', P: ' ',
}

/** Fold the line breaks of a multi-line flow/quoted scalar: a break becomes a space, an empty line a newline. */
function foldLines(lines: string[]): string {
  let out = ''
  let pendingBreaks = 0
  lines.forEach((line, index) => {
    const part = index === 0 ? line.replace(/[ \t]+$/, '') : index === lines.length - 1 ? line.replace(/^[ \t]+/, '') : line.trim()
    if (index > 0) {
      if (part === '' && index < lines.length - 1) { pendingBreaks++; return }
      out += pendingBreaks ? '\n'.repeat(pendingBreaks) : ' '
      pendingBreaks = 0
    }
    out += part
  })
  return out
}

/** Parse a quoted scalar starting at `start` (`'` or `"`). Returns the value and the index after the closing quote. */
export function readQuoted(source: string, start: number, line: number | null = null): { value: string; end: number } {
  const quote = source[start]
  let index = start + 1
  const segments: string[] = []
  let current = ''
  while (index < source.length) {
    const char = source[index]
    if (quote === "'" && char === "'") {
      if (source[index + 1] === "'") { current += "'"; index += 2; continue }
      segments.push(current)
      return { value: segments.length > 1 ? foldLines(segments) : segments[0], end: index + 1 }
    }
    if (quote === '"' && char === '"') {
      segments.push(current)
      return { value: segments.length > 1 ? foldLines(segments) : segments[0], end: index + 1 }
    }
    if (quote === '"' && char === '\\') {
      const next = source[index + 1]
      if (next === '\n') {
        // escaped line break: join without a space, drop the next line's indentation
        index += 2
        while (source[index] === ' ' || source[index] === '\t') index++
        continue
      }
      if (next === 'x' || next === 'u' || next === 'U') {
        const width = next === 'x' ? 2 : next === 'u' ? 4 : 8
        const hex = source.slice(index + 2, index + 2 + width)
        if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) throw new YamlSubsetError('无效的转义序列', line)
        const code = Number.parseInt(hex, 16)
        if (code > 0x10ffff) throw new YamlSubsetError('无效的转义序列', line)
        current += String.fromCodePoint(code)
        index += 2 + width
        continue
      }
      if (next !== undefined && next in DOUBLE_ESCAPES) {
        current += DOUBLE_ESCAPES[next]
        index += 2
        continue
      }
      throw new YamlSubsetError('无效的转义序列', line)
    }
    if (char === '\n') {
      segments.push(current)
      current = ''
      index++
      continue
    }
    current += char
    index++
  }
  throw new YamlSubsetError('引号没有闭合', line)
}

type Props = { anchor: string | null; rest: string }

const ANCHOR = /^&([^\s,[\]{}]+)/

class Parser {
  private readonly lines: Line[]
  private index = 0
  private nodes = 0
  private readonly anchors = new Map<string, { value: YamlValue; count: number }>()
  readonly topLevelKeys: string[] = []
  readonly skipped: string[] = []

  constructor(
    text: string,
    private readonly options: Required<Pick<YamlParseOptions, 'maxDepth' | 'maxNodes'>> & YamlParseOptions,
  ) {
    const rawLines = text.split('\n')
    this.lines = rawLines.map((raw, position) => {
      const line = raw.replace(/\r$/, '')
      const indentMatch = /^[ ]*/.exec(line)
      const indent = indentMatch ? indentMatch[0].length : 0
      const body = line.slice(indent)
      if (body.startsWith('\t') && body.trim() !== '' && !body.trim().startsWith('#')) {
        throw new YamlSubsetError('缩进不能用制表符', position + 1)
      }
      return { indent, text: body.trimEnd(), raw: line, no: position + 1 }
    })
  }

  private count(n = 1) {
    this.nodes += n
    if (this.nodes > this.options.maxNodes) throw new YamlSubsetError(`节点数超过上限 ${this.options.maxNodes}`)
  }

  private depthGuard(depth: number, line: number | null) {
    if (depth > this.options.maxDepth) throw new YamlSubsetError(`嵌套超过 ${this.options.maxDepth} 层`, line)
  }

  /** The next content line (skipping blank and comment-only lines), without consuming it. */
  private peek(): Line | null {
    while (this.index < this.lines.length && isBlank(this.lines[this.index])) this.index++
    return this.index < this.lines.length ? this.lines[this.index] : null
  }

  parseDocument(): YamlValue {
    // directives and a leading document marker
    let first = this.peek()
    while (first && first.indent === 0 && first.text.startsWith('%')) { this.index++; first = this.peek() }
    if (first && first.indent === 0 && (first.text === '---' || first.text.startsWith('--- '))) {
      const rest = stripPlainComment(first.text.slice(3)).trim()
      if (rest) throw new YamlSubsetError('不支持在 --- 同一行写内容', first.no)
      this.index++
    }
    const start = this.peek()
    let value: YamlValue = null
    if (start) {
      if (start.indent === 0 && !isSeqEntry(start.text) && this.splitKey(start.text, start.no)) {
        value = this.parseMapping(0, 0, true)
      } else {
        value = this.parseNode(0, 0)
      }
    }
    const trailing = this.peek()
    if (trailing) {
      if (trailing.indent === 0 && (trailing.text === '---' || trailing.text.startsWith('--- '))) throw new YamlSubsetError('不支持多文档 YAML', trailing.no)
      if (trailing.indent === 0 && trailing.text === '...') {
        this.index++
        if (this.peek()) throw new YamlSubsetError('不支持多文档 YAML', this.peek()?.no ?? null)
      } else {
        throw new YamlSubsetError('缩进不一致或无法解析的行', trailing.no)
      }
    }
    return value
  }

  /** A node whose first line has indent >= minIndent. */
  private parseNode(minIndent: number, depth: number): YamlValue {
    const line = this.peek()
    if (!line || line.indent < minIndent) return null
    this.depthGuard(depth, line.no)
    if (line.indent === 0 && (line.text === '---' || line.text === '...' || line.text.startsWith('--- '))) return null
    if (isSeqEntry(line.text)) return this.parseSequence(line.indent, depth)
    if (this.splitKey(line.text, line.no)) return this.parseMapping(line.indent, depth, false)
    // a lone scalar / flow / alias line
    this.index++
    return this.parseInlineValue(line.text, line.indent - 1, depth, line.no)
  }

  private parseSequence(indent: number, depth: number): YamlValue[] {
    this.depthGuard(depth, null)
    const items: YamlValue[] = []
    this.count()
    for (;;) {
      const line = this.peek()
      if (!line || line.indent !== indent || !isSeqEntry(line.text)) break
      const after = line.text.slice(1)
      const gap = /^[ \t]*/.exec(after)?.[0].length ?? 0
      const content = after.slice(gap)
      const props = this.takeProps(content, line.no)
      if (stripPlainComment(props.rest) === '' && !props.rest.startsWith('"') && !props.rest.startsWith("'")) {
        this.index++
        const child = this.peek()
        const value = child && child.indent > indent ? this.parseNode(indent + 1, depth + 1) : null
        items.push(this.register(props.anchor, value, null))
        continue
      }
      // inline content: re-read it as a line at its own column, so `- name: a` + `  type: ss` form one mapping
      const column = indent + 1 + gap + (content.length - props.rest.length)
      this.lines[this.index] = { indent: column, text: props.rest, raw: line.raw, no: line.no }
      const before = this.nodes
      const value = this.parseNode(column, depth + 1)
      items.push(this.register(props.anchor, value, this.nodes - before))
    }
    return items
  }

  /** `key: rest` split for a block mapping line, or null when the line is not a mapping entry. */
  private splitKey(text: string, line: number): { key: string; rest: string } | null {
    if (text.startsWith('? ')) throw new YamlSubsetError('不支持复杂键', line)
    if (text.startsWith('"') || text.startsWith("'")) {
      let quoted: { value: string; end: number }
      try { quoted = readQuoted(text, 0, line) } catch { return null }
      const after = text.slice(quoted.end)
      const colon = /^[ \t]*:(?=[ \t]|$)/.exec(after)
      if (!colon) return null
      return { key: quoted.value, rest: after.slice(colon[0].length) }
    }
    if (/^[[{|>*&!%@`]/.test(text) || isSeqEntry(text)) return null
    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      if (char === '#' && index > 0 && (text[index - 1] === ' ' || text[index - 1] === '\t')) return null
      if (char === ':' && (index + 1 === text.length || text[index + 1] === ' ' || text[index + 1] === '\t')) {
        const key = text.slice(0, index).trim()
        if (!key) return null
        return { key, rest: text.slice(index + 1) }
      }
    }
    return null
  }

  private parseMapping(indent: number, depth: number, root: boolean): YamlMap {
    this.depthGuard(depth, null)
    const map = newMap()
    const merges: YamlValue[] = []
    this.count()
    for (;;) {
      const line = this.peek()
      if (!line || line.indent < indent) break
      if (line.indent === 0 && (line.text === '---' || line.text === '...' || line.text.startsWith('--- '))) break
      if (line.indent > indent) throw new YamlSubsetError('缩进不一致', line.no)
      if (isSeqEntry(line.text)) break
      const entry = this.splitKey(line.text, line.no)
      if (!entry) throw new YamlSubsetError('无法解析的行', line.no)
      const start = this.index
      this.index++
      if (root) this.topLevelKeys.push(entry.key)
      if (root && this.options.skipKeys?.has(entry.key) && !this.options.requiredKeys?.has(entry.key)) {
        this.skipSection()
        this.skipped.push(entry.key)
        continue
      }
      let value: YamlValue
      if (root && this.options.requiredKeys && !this.options.requiredKeys.has(entry.key)) {
        const nodesBefore = this.nodes
        try {
          value = this.parseMappingValue(entry.rest, indent, depth + 1, line.no)
        } catch (error) {
          if (!(error instanceof YamlSubsetError)) throw error
          // an unrelated section the subset cannot read: skip it rather than reject the whole profile
          this.nodes = nodesBefore
          this.index = start + 1
          this.skipSection()
          this.skipped.push(entry.key)
          continue
        }
      } else {
        value = this.parseMappingValue(entry.rest, indent, depth + 1, line.no)
      }
      if (entry.key === '<<') { merges.push(value); continue }
      if (FORBIDDEN_KEYS.has(entry.key)) continue
      map[entry.key] = value
      this.count()
    }
    for (const merge of merges) this.applyMerge(map, merge)
    return map
  }

  /** Skip the rest of a top-level section: everything up to the next column-0 key. */
  private skipSection() {
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]
      if (!isBlank(line) && line.indent === 0 && !isSeqEntry(line.text) && /^[^\s#-][^#]*?:(\s|$)/.test(line.text)) return
      if (!isBlank(line) && line.indent === 0 && (line.text === '---' || line.text === '...')) return
      this.index++
    }
  }

  private applyMerge(map: YamlMap, merge: YamlValue) {
    const sources = Array.isArray(merge) ? merge : [merge]
    for (const source of sources) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new YamlSubsetError('<< 只能合并映射')
      for (const key of Object.keys(source)) {
        if (FORBIDDEN_KEYS.has(key) || Object.prototype.hasOwnProperty.call(map, key)) continue
        map[key] = source[key]
        this.count()
      }
    }
  }

  private takeProps(text: string, line: number): Props {
    let rest = text
    let anchor: string | null = null
    for (;;) {
      if (rest.startsWith('!')) throw new YamlSubsetError('不支持 YAML 标签', line)
      const match = ANCHOR.exec(rest)
      if (!match) break
      if (anchor) throw new YamlSubsetError('重复的锚点', line)
      anchor = match[1]
      rest = rest.slice(match[0].length).replace(/^[ \t]+/, '')
    }
    return { anchor, rest }
  }

  private register(anchor: string | null, value: YamlValue, count: number | null): YamlValue {
    if (anchor) this.anchors.set(anchor, { value, count: Math.max(1, count ?? 1) })
    return value
  }

  private parseMappingValue(rest: string, indent: number, depth: number, lineNo: number): YamlValue {
    const props = this.takeProps(rest.replace(/^[ \t]+/, ''), lineNo)
    const body = props.rest
    const before = this.nodes
    if (stripPlainComment(body) === '' && !body.startsWith('"') && !body.startsWith("'")) {
      const next = this.peek()
      let value: YamlValue = null
      if (next && next.indent > indent) value = this.parseNode(indent + 1, depth)
      else if (next && next.indent === indent && isSeqEntry(next.text)) value = this.parseSequence(indent, depth)
      return this.register(props.anchor, value, this.nodes - before)
    }
    const value = this.parseInlineValue(body, indent, depth, lineNo)
    return this.register(props.anchor, value, this.nodes - before)
  }

  /** The value part of a line: block scalar header, alias, flow collection, quoted or plain scalar. */
  private parseInlineValue(body: string, parentIndent: number, depth: number, lineNo: number): YamlValue {
    const props = this.takeProps(body, lineNo)
    const text = props.rest
    const before = this.nodes
    let value: YamlValue
    if (text.startsWith('|') || text.startsWith('>')) {
      value = this.readBlockScalar(text, parentIndent, lineNo)
      this.count()
    } else if (text.startsWith('*')) {
      const name = /^\*([^\s,[\]{}]+)/.exec(text)?.[1] ?? ''
      if (stripPlainComment(text.slice(name.length + 1)).trim()) throw new YamlSubsetError('别名后不能再有内容', lineNo)
      value = this.alias(name, lineNo)
    } else if (text.startsWith('[') || text.startsWith('{')) {
      value = this.readFlow(text, parentIndent, depth, lineNo)
    } else if (text.startsWith('"') || text.startsWith("'")) {
      value = this.readQuotedValue(text, parentIndent, lineNo)
      this.count()
    } else {
      value = this.readPlain(text, parentIndent)
      this.count()
    }
    return this.register(props.anchor, value, this.nodes - before)
  }

  private alias(name: string, line: number | null): YamlValue {
    const anchored = this.anchors.get(name)
    if (!anchored) throw new YamlSubsetError(`未定义的锚点 *${name}`, line)
    this.count(anchored.count)
    return anchored.value
  }

  private readPlain(first: string, parentIndent: number): string | null {
    const parts = [stripPlainComment(first)]
    if (plainCommentAt(first) < 0) {
      // continuation lines of a multi-line plain scalar
      for (;;) {
        const next = this.peek()
        if (!next || next.indent <= parentIndent || isSeqEntry(next.text) || this.splitKey(next.text, next.no)) break
        this.index++
        const at = plainCommentAt(next.text)
        parts.push(at < 0 ? next.text : next.text.slice(0, at).trimEnd())
        if (at >= 0) break
      }
    }
    return plainScalar(parts.length > 1 ? foldLines(parts) : parts[0])
  }

  private readQuotedValue(first: string, parentIndent: number, lineNo: number): string {
    let source = first
    let consumed = 0
    for (;;) {
      try {
        const { value, end } = readQuoted(source, 0, lineNo)
        const tail = source.slice(end)
        if (stripPlainComment(tail).trim()) throw new YamlSubsetError('引号后不能再有内容', lineNo)
        return value
      } catch (error) {
        if (!(error instanceof YamlSubsetError) || !error.message.includes('引号没有闭合')) throw error
        const next = this.lines[this.index]
        if (!next || consumed > 200 || (next.text !== '' && next.indent <= parentIndent)) throw error
        source += `\n${next.raw}`
        this.index++
        consumed++
      }
    }
  }

  private readBlockScalar(header: string, parentIndent: number, lineNo: number): string {
    const match = /^([|>])([+-]?)([1-9]?)([+-]?)[ \t]*(#.*)?$/.exec(header)
    if (!match || (match[2] && match[4])) throw new YamlSubsetError('无效的块标量头', lineNo)
    const literal = match[1] === '|'
    const chomp = match[2] || match[4] || ''
    const explicit = match[3] ? parentIndent + Number(match[3]) : null
    const collected: string[] = []
    let contentIndent = explicit
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]
      const blank = line.raw.trim() === ''
      if (!blank) {
        if (contentIndent === null) {
          if (line.indent <= parentIndent) break
          contentIndent = line.indent
        }
        if (line.indent < contentIndent) break
      }
      collected.push(blank ? '' : line.raw.slice(contentIndent ?? 0))
      this.index++
    }
    let trailing = 0
    while (collected.length && collected[collected.length - 1] === '') { collected.pop(); trailing++ }
    let text: string
    if (literal) {
      text = collected.join('\n')
    } else {
      text = ''
      collected.forEach((line, position) => {
        if (position === 0) { text = line; return }
        const previous = collected[position - 1]
        if (line === '') text += '\n'
        else if (previous === '' || /^[ \t]/.test(line) || /^[ \t]/.test(previous)) text += (previous === '' ? '' : '\n') + line
        else text += ` ${line}`
      })
    }
    if (!collected.length) return chomp === '+' ? '\n'.repeat(trailing) : ''
    if (chomp === '-') return text
    if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`
    return `${text}\n`
  }

  /** A flow collection; continuation lines are joined until the brackets balance. */
  private readFlow(first: string, parentIndent: number, depth: number, lineNo: number): YamlValue {
    let source = first
    let lines = 0
    while (!flowBalanced(source)) {
      const next = this.lines[this.index]
      if (!next || lines > 5000) throw new YamlSubsetError('括号没有闭合', lineNo)
      if (next.text !== '' && next.indent <= parentIndent && !/^[\]}]/.test(next.text)) throw new YamlSubsetError('括号没有闭合', lineNo)
      source += `\n${next.raw}`
      this.index++
      lines++
    }
    const reader = new FlowReader(source, this, depth, lineNo)
    const value = reader.node()
    reader.skipSpace()
    if (reader.position < source.length) throw new YamlSubsetError('流式集合后不能再有内容', lineNo)
    return value
  }

  // FlowReader hooks
  flowCount(n = 1) { this.count(n) }
  flowAlias(name: string, line: number) { return this.alias(name, line) }
  flowRegister(anchor: string | null, value: YamlValue, count: number) { return this.register(anchor, value, count) }
  flowDepth(depth: number, line: number) { this.depthGuard(depth, line) }
  get nodeCount() { return this.nodes }
}

/** True once every `[`/`{` opened outside quotes and comments is closed. */
function flowBalanced(source: string): boolean {
  let depth = 0
  let tokenStart = true
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if ((char === '"' || char === "'") && tokenStart) {
      try { index = readQuoted(source, index).end - 1 } catch { return false }
      tokenStart = false
      continue
    }
    if (char === '#' && (index === 0 || /[\s]/.test(source[index - 1]))) {
      const end = source.indexOf('\n', index)
      if (end < 0) break
      index = end
      tokenStart = true
      continue
    }
    if (char === '[' || char === '{') { depth++; tokenStart = true; continue }
    if (char === ']' || char === '}') { depth--; tokenStart = false; if (depth <= 0) return depth === 0; continue }
    if (char === ',' || char === ':' ) { tokenStart = true; continue }
    if (char === ' ' || char === '\t' || char === '\n') continue
    tokenStart = false
  }
  return depth === 0
}

class FlowReader {
  position = 0
  constructor(private readonly source: string, private readonly parser: Parser, private readonly depth: number, private readonly line: number) {}

  skipSpace() {
    while (this.position < this.source.length) {
      const char = this.source[this.position]
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') { this.position++; continue }
      if (char === '#' && (this.position === 0 || /\s/.test(this.source[this.position - 1]))) {
        const end = this.source.indexOf('\n', this.position)
        this.position = end < 0 ? this.source.length : end
        continue
      }
      break
    }
  }

  node(depth = this.depth): YamlValue {
    this.parser.flowDepth(depth, this.line)
    this.skipSpace()
    let anchor: string | null = null
    if (this.source[this.position] === '!') throw new YamlSubsetError('不支持 YAML 标签', this.line)
    if (this.source[this.position] === '&') {
      const match = ANCHOR.exec(this.source.slice(this.position))
      if (!match) throw new YamlSubsetError('无效的锚点', this.line)
      anchor = match[1]
      this.position += match[0].length
      this.skipSpace()
    }
    const before = this.parser.nodeCount
    const char = this.source[this.position]
    let value: YamlValue
    if (char === '[') value = this.sequence(depth)
    else if (char === '{') value = this.mapping(depth)
    else if (char === '*') {
      const match = /^\*([^\s,[\]{}]+)/.exec(this.source.slice(this.position))
      if (!match) throw new YamlSubsetError('无效的别名', this.line)
      this.position += match[0].length
      value = this.parser.flowAlias(match[1], this.line)
    } else if (char === '"' || char === "'") {
      const quoted = readQuoted(this.source, this.position, this.line)
      this.position = quoted.end
      value = quoted.value
      this.parser.flowCount()
    } else {
      value = this.plain()
      this.parser.flowCount()
    }
    return this.parser.flowRegister(anchor, value, this.parser.nodeCount - before)
  }

  private plain(): string | null {
    const start = this.position
    while (this.position < this.source.length) {
      const char = this.source[this.position]
      if (char === ',' || char === '[' || char === ']' || char === '{' || char === '}') break
      if (char === ':') {
        const next = this.source[this.position + 1]
        if (next === undefined || next === ' ' || next === '\t' || next === '\n' || next === ',' || next === ']' || next === '}') break
      }
      if (char === '#' && /\s/.test(this.source[this.position - 1] ?? '')) break
      this.position++
    }
    const raw = this.source.slice(start, this.position)
    const parts = raw.split('\n')
    return plainScalar(parts.length > 1 ? foldLines(parts) : raw)
  }

  private sequence(depth: number): YamlValue[] {
    this.position++
    const items: YamlValue[] = []
    this.parser.flowCount()
    for (;;) {
      this.skipSpace()
      if (this.source[this.position] === ']') { this.position++; return items }
      if (this.position >= this.source.length) throw new YamlSubsetError('括号没有闭合', this.line)
      const item = this.node(depth + 1)
      this.skipSpace()
      if (this.source[this.position] === ':') {
        // single-pair mapping inside a flow sequence: [a: 1]
        this.position++
        const pair = newMap()
        const value = this.atEntryEnd() ? null : this.node(depth + 2)
        if (typeof item === 'string' && !FORBIDDEN_KEYS.has(item)) pair[item] = value
        items.push(pair)
      } else {
        items.push(item)
      }
      this.skipSpace()
      const separator = this.source[this.position]
      if (separator === ',') { this.position++; continue }
      if (separator === ']') { this.position++; return items }
      throw new YamlSubsetError('流式序列缺少逗号', this.line)
    }
  }

  private atEntryEnd(): boolean {
    this.skipSpace()
    const char = this.source[this.position]
    return char === ',' || char === '}' || char === ']'
  }

  private mapping(depth: number): YamlMap {
    this.position++
    const map = newMap()
    const merges: YamlValue[] = []
    this.parser.flowCount()
    for (;;) {
      this.skipSpace()
      if (this.source[this.position] === '}') { this.position++; break }
      if (this.position >= this.source.length) throw new YamlSubsetError('括号没有闭合', this.line)
      const keyValue = this.node(depth + 1)
      if (keyValue !== null && typeof keyValue !== 'string') throw new YamlSubsetError('不支持复杂键', this.line)
      const key = keyValue ?? ''
      this.skipSpace()
      let value: YamlValue = null
      if (this.source[this.position] === ':') {
        this.position++
        value = this.atEntryEnd() ? null : this.node(depth + 1)
      }
      if (key === '<<') merges.push(value)
      else if (!FORBIDDEN_KEYS.has(key)) { map[key] = value; this.parser.flowCount() }
      this.skipSpace()
      const separator = this.source[this.position]
      if (separator === ',') { this.position++; continue }
      if (separator === '}') { this.position++; break }
      throw new YamlSubsetError('流式映射缺少逗号', this.line)
    }
    for (const merge of merges) {
      for (const source of Array.isArray(merge) ? merge : [merge]) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw new YamlSubsetError('<< 只能合并映射', this.line)
        for (const key of Object.keys(source)) {
          if (FORBIDDEN_KEYS.has(key) || Object.prototype.hasOwnProperty.call(map, key)) continue
          map[key] = source[key]
          this.parser.flowCount()
        }
      }
    }
    return map
  }
}

/** Parse a YAML document in the supported subset. Throws YamlSubsetError (zh message with the line number). */
export function parseYamlSubset(input: string, options: YamlParseOptions = {}): YamlParseResult {
  const maxBytes = options.maxBytes ?? YAML_LIMITS.maxBytes
  if (Buffer.byteLength(input, 'utf8') > maxBytes) throw new YamlSubsetError(`内容超过 ${Math.round(maxBytes / 1024 / 1024)} MiB`)
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const parser = new Parser(text, {
    ...options,
    maxDepth: options.maxDepth ?? YAML_LIMITS.maxDepth,
    maxNodes: options.maxNodes ?? YAML_LIMITS.maxNodes,
  })
  const value = parser.parseDocument()
  return { value, topLevelKeys: parser.topLevelKeys, skipped: parser.skipped }
}
