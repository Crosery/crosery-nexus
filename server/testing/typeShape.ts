/**
 * Runtime check of a JSON value against a TypeScript type the front end declares (`src/types.ts`, feature models).
 * The checker reads the very types the pages compile against, so there is no second schema to drift from them:
 * a required property the server does not send, a renamed field, a string where a number is declared, a value
 * outside a literal union — each is an issue with its JSON path. Extra properties are fine (the page ignores them).
 *
 * Strict null checks are on here even though the app build has them off: the types spell `| null` and `?` out, and
 * without strict mode the checker would erase `null` from every union.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { scriptBlocks } from './frontendCalls.js'

export type ShapeChecker = {
  /** issues for `value` against the exported type `name` of `file` (repo-relative); [] = it fits */
  check: (file: string, name: string, value: unknown) => string[]
}

const MAX_DEPTH = 40
const MAX_ELEMENTS = 200

/** A `.vue` file is read as `<file>.vue.ts` holding its `<script>` blocks, so page-local types can be checked too. */
const VUE_AS_TS = /\.vue\.ts$/
const asProgramFile = (repo: string, file: string) => path.join(repo, file.endsWith('.vue') ? `${file}.ts` : file)

export function createShapeChecker(repo: string, files: string[]): ShapeChecker {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    lib: ['lib.es2023.d.ts'],
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile
  host.getSourceFile = (fileName, language, onError, create) => {
    if (!VUE_AS_TS.test(fileName)) return getSourceFile.call(host, fileName, language, onError, create)
    const code = scriptBlocks(fs.readFileSync(fileName.slice(0, -3), 'utf8')).map(block => block.code).join('\n')
    return ts.createSourceFile(fileName, code, language)
  }
  const fileExists = host.fileExists
  host.fileExists = fileName => (VUE_AS_TS.test(fileName) ? fs.existsSync(fileName.slice(0, -3)) : fileExists.call(host, fileName))
  const program = ts.createProgram(files.map(file => asProgramFile(repo, file)), options, host)
  const checker = program.getTypeChecker()
  const exported = new Map<string, ts.Type>()

  const typeOf = (file: string, name: string): ts.Type => {
    const key = `${file}#${name}`
    const cached = exported.get(key)
    if (cached) return cached
    const source = program.getSourceFile(asProgramFile(repo, file))
    if (!source) throw new Error(`${file} is not in the shape checker's program`)
    // an SFC's types are not exported: fall back to the script's top-level declarations
    const module = checker.getSymbolAtLocation(source)
    const symbol = (module && checker.getExportsOfModule(module).find(entry => entry.name === name))
      ?? checker.getSymbolsInScope(source, ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface).find(entry => entry.name === name)
    if (!symbol) throw new Error(`${file} does not declare a type ${name}`)
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    const type = checker.getDeclaredTypeOfSymbol(target)
    exported.set(key, type)
    return type
  }

  const show = (type: ts.Type) => checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
  const got = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)
  const allowsUndefined = (type: ts.Type) =>
    Boolean(type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown))
    || (type.isUnion() && type.types.some(allowsUndefined))

  function visit(type: ts.Type, value: unknown, at: string, issues: string[], depth: number): void {
    if (depth > MAX_DEPTH) return
    const flags = type.flags
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return
    if (type.isUnion()) {
      let closest: string[] | null = null
      for (const member of type.types) {
        const attempt: string[] = []
        visit(member, value, at, attempt, depth + 1)
        if (attempt.length === 0) return
        if (!closest || attempt.length < closest.length) closest = attempt
      }
      // a missing value or a wrong primitive reads better as one line than as the closest member's issues
      if (value === null || typeof value !== 'object') issues.push(`${at}: expected ${show(type)}, got ${JSON.stringify(value)}`)
      else issues.push(...(closest ?? [`${at}: expected ${show(type)}`]))
      return
    }
    if (type.isIntersection()) {
      for (const member of type.types) visit(member, value, at, issues, depth + 1)
      return
    }
    if (flags & ts.TypeFlags.Null) { if (value !== null) issues.push(`${at}: expected null, got ${got(value)}`); return }
    if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) { if (value !== undefined) issues.push(`${at}: expected undefined, got ${got(value)}`); return }
    if (flags & ts.TypeFlags.Never) { issues.push(`${at}: no value is allowed here (never)`); return }
    if (type.isStringLiteral() || type.isNumberLiteral()) {
      if (value !== type.value) issues.push(`${at}: expected ${JSON.stringify(type.value)}, got ${JSON.stringify(value)}`)
      return
    }
    if (flags & ts.TypeFlags.BooleanLiteral) {
      const expected = show(type) === 'true'
      if (value !== expected) issues.push(`${at}: expected ${expected}, got ${JSON.stringify(value)}`)
      return
    }
    if (flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) { if (typeof value !== 'string') issues.push(`${at}: expected string, got ${got(value)}`); return }
    if (flags & ts.TypeFlags.Number) { if (typeof value !== 'number') issues.push(`${at}: expected number, got ${got(value)}`); return }
    if (flags & ts.TypeFlags.Boolean) { if (typeof value !== 'boolean') issues.push(`${at}: expected boolean, got ${got(value)}`); return }
    if (!(flags & ts.TypeFlags.Object)) { issues.push(`${at}: unsupported type ${show(type)}`); return }

    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      if (!Array.isArray(value)) { issues.push(`${at}: expected ${show(type)}, got ${got(value)}`); return }
      const args = checker.getTypeArguments(type as ts.TypeReference)
      value.slice(0, MAX_ELEMENTS).forEach((item, index) => {
        const element = checker.isTupleType(type) ? args[index] : args[0]
        if (element) visit(element, item, `${at}[${index}]`, issues, depth + 1)
      })
      return
    }
    if (type.getCallSignatures().length && !type.getProperties().length) return
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { issues.push(`${at}: expected object ${show(type)}, got ${got(value)}`); return }
    const record = value as Record<string, unknown>
    const declared = new Set<string>()
    for (const property of checker.getPropertiesOfType(type)) {
      declared.add(property.name)
      const propertyType = checker.getTypeOfSymbol(property)
      const optional = Boolean(property.flags & ts.SymbolFlags.Optional) || allowsUndefined(propertyType)
      const child = `${at}.${property.name}`
      if (record[property.name] === undefined) {
        if (!optional) issues.push(`${child}: missing (declared ${show(propertyType)})`)
        continue
      }
      visit(propertyType, record[property.name], child, issues, depth + 1)
    }
    for (const index of checker.getIndexInfosOfType(type)) {
      if (!(index.keyType.flags & ts.TypeFlags.String)) continue
      for (const [key, item] of Object.entries(record)) if (!declared.has(key)) visit(index.type, item, `${at}[${JSON.stringify(key)}]`, issues, depth + 1)
    }
  }

  return {
    check(file, name, value) {
      const issues: string[] = []
      visit(typeOf(file, name), value, name, issues, 0)
      return issues
    },
  }
}
