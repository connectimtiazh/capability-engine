import type { FileStore } from '../capability/store.js'
import type { Capability } from '../capability/schema.js'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  returns: Record<string, unknown>
  unattended: boolean
  ref: string
}

// Ruling F5: collapse non-alphanumeric runs within each `/`-separated part, but keep
// the vendor/name boundary itself as a double underscore rather than folding it into
// the same single-underscore run as everything else. That boundary is the one piece
// of structure worth preserving in a flat tool name: it keeps names readable
// ("quest_core__member_savings_balance") and lets a caller split back on `__` to
// recover which vendor a tool came from, which a single collapse would destroy.
const toolName = (key: string): string =>
  key.split('/').map((part) => part.replace(/[^a-zA-Z0-9]+/g, '_')).join('__')

/** A saved capability, rendered as something an agent can call by name.
 *
 *  Nothing here is generated: inputs and outputs were declared in the artifact at
 *  compile time, so the tool contract and the replay contract cannot drift apart. */
export function toolDefinition(c: Capability): ToolDefinition {
  const outs = Object.keys(c.outputs.properties).join(', ')
  return {
    name: toolName(c.key),
    ref: `${c.key}@${c.version}`,
    description: `${c.title}. Returns: ${outs || '(nothing)'}.`,
    parameters: {
      type: 'object',
      required: c.inputs.required,
      properties: Object.fromEntries(
        Object.entries(c.inputs.properties).map(([k, v]) => [
          k,
          { type: v.type, ...(v.pattern ? { pattern: v.pattern } : {}) },
        ]),
      ),
    },
    returns: c.outputs as unknown as Record<string, unknown>,
    // Autonomy is a permission a behaviour earns; the evidence is replay history.
    // A `draft` capability has not earned unattended invocation — only `approved`
    // capabilities may run without a human present. See src/cli/catalog.ts for the
    // corresponding enforcement point (this module only reports the fact).
    unattended: c.approval.state === 'approved',
  }
}

export async function buildCatalog(store: FileStore): Promise<ToolDefinition[]> {
  const caps = await store.listCapabilities()
  return caps.map(toolDefinition).sort((a, b) => a.name.localeCompare(b.name))
}
