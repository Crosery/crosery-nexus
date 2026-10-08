/**
 * Every console HTTP call the front end makes, read from `src/**` (`.ts` and the `<script>` blocks of `.vue`)
 * with the TypeScript parser: each string or template literal that starts with `/api/` is followed up to the
 * fetch-like call it feeds, and becomes `{ method, path }` with `${…}` path segments as `:param`.
 *
 * - The method comes from that call's init argument (`{ method: 'POST' }`, the proxy client's `json('POST', …)`,
 *   or a local `const init = {…}`); no init → GET.
 * - A literal that feeds a URL builder (`scoped(…)`, `marked(…)`, a function returning the URL for EventSource) is
 *   followed outward until a fetch-like call or the function boundary (→ GET).
 * - A literal that is not a call (a probe list, a comparison) is reported as `reference`; the contract test
 *   keeps those in a commented allowlist so a call the extractor cannot read never passes silently.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export type FrontendCall = {
  file: string
  line: number
  kind: 'call' | 'url' | 'reference'
  method: string
  path: string
}

const FETCHERS = new Set(['request', 'rtkRequest', 'fetch'])
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

function listSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSources(full))
    else if (/\.(ts|vue)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** `<script>` / `<script setup>` bodies of an SFC with the line they start on. */
export function scriptBlocks(text: string): Array<{ code: string; lineOffset: number }> {
  const blocks: Array<{ code: string; lineOffset: number }> = []
  for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const start = (match.index ?? 0) + match[0].indexOf('>') + 1
    blocks.push({ code: match[1], lineOffset: text.slice(0, start).split('\n').length - 1 })
  }
  return blocks
}

const calleeName = (call: ts.CallExpression): string => {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return ''
}

/** The literal's path: `${…}` after a `/` is a `:param`; one glued to the path end (`${qs(…)}`, `${suffix}`) is a query. */
function pathOf(node: ts.StringLiteralLike | ts.TemplateExpression): string {
  let text = ts.isTemplateExpression(node) ? node.head.text : node.text
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      if (/[?#]/.test(text)) break
      if (!text.endsWith('/')) {
        if (/^[^?#]*\//.test(span.literal.text)) throw new Error(`unsupported URL template: ${node.getText()}`)
        break
      }
      text += `:param${span.literal.text}`
    }
  }
  return text.replace(/[?#].*$/, '')
}

function methodOf(init: ts.Expression | undefined, file: ts.SourceFile): string | null {
  if (!init) return 'GET'
  if (ts.isIdentifier(init)) {
    let declared: ts.Expression | undefined
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === init.text && node.initializer) declared = node.initializer
      ts.forEachChild(node, visit)
    }
    visit(file)
    return declared ? methodOf(declared, file) : null
  }
  if (ts.isObjectLiteralExpression(init)) {
    for (const property of init.properties) {
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'method') return null
      if (!ts.isPropertyAssignment(property) || property.name.getText(file) !== 'method') continue
      return ts.isStringLiteralLike(property.initializer) ? property.initializer.text.toUpperCase() : null
    }
    return 'GET'
  }
  // the proxy client's `json('PATCH', body)`
  if (ts.isCallExpression(init) && init.arguments[0] && ts.isStringLiteralLike(init.arguments[0]) && METHODS.has(init.arguments[0].text.toUpperCase())) {
    return init.arguments[0].text.toUpperCase()
  }
  return null
}

/** Follow the literal outward to the call it feeds. */
function usageOf(literal: ts.Node, file: ts.SourceFile): { kind: FrontendCall['kind']; method: string | null } {
  let node: ts.Node = literal
  for (;;) {
    const parent = node.parent
    if (!parent) return { kind: 'reference', method: null }
    if (ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent) || ts.isParenthesizedExpression(parent)
      || ts.isAsExpression(parent) || ts.isConditionalExpression(parent) || ts.isAwaitExpression(parent)) {
      node = parent
      continue
    }
    if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) {
      if (FETCHERS.has(calleeName(parent)) && parent.arguments[0] === node) return { kind: 'call', method: methodOf(parent.arguments[1], file) }
      node = parent
      continue
    }
    if (ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'EventSource') return { kind: 'call', method: 'GET' }
    if ((ts.isArrowFunction(parent) && parent.body === node) || ts.isReturnStatement(parent)) return { kind: 'url', method: 'GET' }
    return { kind: 'reference', method: null }
  }
}

function callsIn(code: string, fileName: string, relative: string, lineOffset: number): FrontendCall[] {
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: FrontendCall[] = []
  const visit = (node: ts.Node) => {
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
    const head = ts.isTemplateExpression(node) ? node.head.text : literal ? (node as ts.StringLiteralLike).text : ''
    if (literal && /^\/api(\/|$|\?)/.test(head) && !ts.isImportDeclaration(node.parent)) {
      const usage = usageOf(node, file)
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 + lineOffset
      out.push({
        file: relative,
        line,
        kind: usage.kind,
        method: usage.method ?? '?',
        path: pathOf(node as ts.StringLiteralLike | ts.TemplateExpression),
      })
      if (ts.isTemplateExpression(node)) return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

/** The `.ts` / `.vue` sources under `src/`, relative to `repo`. */
export const frontendSources = (repo: string): string[] => listSources(path.join(repo, 'src')).map(full => path.relative(repo, full))

/** All `/api` literals under `src/`, file paths relative to `repo`. */
export function frontendCalls(repo: string): FrontendCall[] {
  const out: FrontendCall[] = []
  for (const relative of frontendSources(repo)) {
    const full = path.join(repo, relative)
    const text = fs.readFileSync(full, 'utf8')
    const blocks = full.endsWith('.vue') ? scriptBlocks(text) : [{ code: text, lineOffset: 0 }]
    for (const block of blocks) out.push(...callsIn(block.code, full, relative, block.lineOffset))
  }
  return out
}

/** `api.<member>` / `api.<ns>.<member>` chains a file reads (the shared client in `src/api/index.ts`). */
export function apiMembersUsed(repo: string, relativeFile: string): string[] {
  const full = path.join(repo, relativeFile)
  const text = fs.readFileSync(full, 'utf8')
  const blocks = full.endsWith('.vue') ? scriptBlocks(text) : [{ code: text, lineOffset: 0 }]
  const used = new Set<string>()
  for (const block of blocks) {
    const file = ts.createSourceFile(full, block.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'api') {
        const outer = node.parent
        used.add(ts.isPropertyAccessExpression(outer) && outer.expression === node ? `${node.name.text}.${outer.name.text}` : node.name.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return [...used].sort()
}
