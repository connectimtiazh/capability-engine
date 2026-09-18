import { createHash } from 'node:crypto'

const SALT = process.env.REDACTION_SALT ?? 'capability-engine-dev-salt'

export type Sensitivity = 'pii' | 'secret' | 'safe'

export function redactValue(v: unknown, s: Sensitivity): unknown {
  if (s === 'safe') return v
  if (s === 'secret') return '[redacted]'
  const h = createHash('sha256').update(SALT).update(String(v)).digest('hex').slice(0, 12)
  return `sha256:${h}`
}

interface InputSchemaish {
  properties: Record<string, Record<string, unknown>>
}

/** Sensitivity is read from the schema, not guessed from the value. A field the
 *  schema does not mention is redacted rather than passed through: an unknown
 *  field is exactly the case where we cannot reason about what it holds. */
export function redactParams(
  params: Record<string, unknown>,
  schema: InputSchemaish,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    const prop = schema.properties[k]
    if (!prop) {
      out[k] = '[redacted]'
      continue
    }
    const s = (prop['x-sensitivity'] as Sensitivity | undefined) ?? 'safe'
    out[k] = redactValue(v, s)
  }
  return out
}
