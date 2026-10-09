/** Keys and values that must never reach a browser: every key matching SECRET_KEY, and each listed value. */
export const SECRET_KEY = /(^|_|-)(access|refresh|id)?_?token$|token|secret|password|cookie|api[-_]?key|^auth$|authorization|verifier/i

export function secretFindings(value: unknown, secretValues: string[] = []): string[] {
  const findings: string[] = []
  const walk = (node: unknown, trail: string) => {
    if (typeof node === 'string') {
      for (const secret of secretValues) if (secret && node.includes(secret)) findings.push(`${trail}: carries a fixture secret`)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (!Array.isArray(node) && SECRET_KEY.test(key)) findings.push(`${trail}.${key}`)
      walk(child, `${trail}.${key}`)
    }
  }
  walk(value, '$')
  return findings
}
