export type JsonSchema = Record<string, unknown>

export function objectSchema(properties: Record<string, unknown>, required?: string[]): JsonSchema {
  const requiredList = required ?? Object.entries(properties).filter(([, value]) => (value as { required?: boolean }).required).map(([key]) => key)
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    clean[key] = cleanSchemaNode(value)
  }
  return { type: 'object', properties: clean, required: requiredList, additionalProperties: false }
}

// Recursively strip boolean `required` shorthand flags from nested schema nodes
// (invalid JSON Schema: `required` is only a valid keyword on objects, as an
// array of property names) and promote them to a proper `required` array on the
// enclosing object that declares `properties`.
function cleanSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanSchemaNode)
  if (typeof node !== 'object' || node === null) return node
  const record = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'required') continue
    out[key] = cleanSchemaNode(value)
  }
  if (typeof record.properties === 'object' && record.properties !== null) {
    const requiredList = Object.entries(record.properties as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'object' && v !== null && (v as { required?: boolean }).required === true)
      .map(([k]) => k)
    if (requiredList.length > 0) out.required = requiredList
  }
  return out
}
