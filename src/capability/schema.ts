import { z } from 'zod'

const SEMVER = /^\d+\.\d+\.\d+$/

export const SensitivitySchema = z.enum(['pii', 'secret', 'safe'])

export const CheckpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text-present'), framePath: z.array(z.string()).optional(), text: z.string() }),
  z.object({ kind: z.literal('role-present'), framePath: z.array(z.string()).optional(), role: z.string(), nameContains: z.string().optional() }),
  z.object({ kind: z.literal('url-matches'), pattern: z.string() }),
  z.object({ kind: z.literal('field-has-value'), framePath: z.array(z.string()).optional(), role: z.string(), name: z.string() }),
  // The value that landed in the control must be traced back to the input parameter
  // that was supposed to produce it — a control merely holding *something* is not
  // evidence the fill actually wrote what this invocation asked for (a stale value
  // left over from a previous run would pass field-has-value silently).
  z.object({
    kind: z.literal('field-value-matches-input'),
    framePath: z.array(z.string()).optional(),
    role: z.string(),
    name: z.string(),
    input: z.string(),
  }),
])
export type Checkpoint = z.infer<typeof CheckpointSchema>

export const FallbackSchema = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('name-attr'), value: z.string() }),
  z.object({ strategy: z.literal('nth-input-in-form'), form: z.number().int().min(0), index: z.number().int().min(0) }),
  z.object({ strategy: z.literal('nth-submit-in-form'), form: z.number().int().min(0), index: z.number().int().min(0) }),
  z.object({ strategy: z.literal('link-text'), value: z.string() }),
])

export const TargetDescriptorSchema = z.object({
  role: z.string(),
  name: z.string().optional(),
  labelText: z.string().optional(),
  framePath: z.array(z.string()).default([]),
  anchor: z
    .object({
      kind: z.literal('table-cell'),
      rowHeader: z.string(),
      offset: z.object({ col: z.number().int() }),
    })
    .optional(),
  fallbacks: z.array(FallbackSchema).default([]),
})
export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>

export const ActionSchema = z.enum(['navigate', 'click', 'fill', 'select', 'read', 'waitFor', 'dismiss'])
export type ActionKind = z.infer<typeof ActionSchema>

export const RecoveryRungSchema = z.discriminatedUnion('when', [
  z.object({ when: z.literal('dialog-present'), match: z.string(), do: z.literal('dismiss') }),
  z.object({ when: z.literal('timeout'), do: z.literal('retry'), max: z.number().int().min(1).max(5), backoffMs: z.number().int().min(0) }),
  z.object({ when: z.literal('session-expired'), do: z.literal('reauth') }),
])
export type RecoveryRung = z.infer<typeof RecoveryRungSchema>

export const StepSchema = z.object({
  id: z.string().min(1),
  intent: z.string().min(1),
  action: ActionSchema,
  target: TargetDescriptorSchema.optional(),
  url: z.string().optional(),
  value: z.union([z.object({ fromInput: z.string() }), z.object({ literal: z.string() })]).optional(),
  extract: z.object({ into: z.string(), as: z.enum(['string', 'number', 'date']) }).optional(),
  checkpoint: CheckpointSchema,
  onError: z.array(RecoveryRungSchema).default([]),
  timeoutMs: z.number().int().min(100).max(60_000).default(8000),
})
export type Step = z.infer<typeof StepSchema>

export const BusinessOutcomeSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  detect: CheckpointSchema,
  terminal: z.boolean(),
  message: z.string().optional(),
  // An outcome detector authored for one screen must never fire on another: unscoped,
  // a string like "No record found" could match unrelated text anywhere in the app.
  // A human author declares the scope; discovery/compile never widen it.
  when: z
    .object({
      route: z.string().optional(),
      framePath: z.array(z.string()).optional(),
    })
    .optional(),
})
export type BusinessOutcome = z.infer<typeof BusinessOutcomeSchema>

export const JsonSchemaish = z.object({
  type: z.literal('object'),
  required: z.array(z.string()).default([]),
  properties: z.record(z.record(z.unknown())),
})

export const CapabilitySchema = z.object({
  apiVersion: z.literal('capability/v1'),
  key: z.string().min(1),
  version: z.string().regex(SEMVER),
  title: z.string().min(1),
  description: z.string().min(1),
  surface: z.object({ kind: z.enum(['web', 'desktop']) }),
  vendor: z.object({ product: z.string(), observedVersion: z.string().optional() }),
  inputs: JsonSchemaish,
  outputs: JsonSchemaish,
  steps: z.array(StepSchema).min(1),
  successCondition: CheckpointSchema,
  businessOutcomes: z.array(BusinessOutcomeSchema).default([]),
  // Typing into a search box does not mutate the bank's state — conflating "the UI
  // received input" with "the ledger changed" made the governance model incoherent.
  // interaction is a fact derived from action verbs; business is a claim about the
  // world, and businessSetBy records who is answerable for that claim.
  risk: z.object({
    interaction: z.enum(['read', 'ui_mutation']),
    business: z.enum(['read', 'mutation', 'irreversible', 'unclassified']),
    businessSetBy: z.enum(['model-proposed', 'human-confirmed', 'default']),
  }),
  provenance: z.object({
    discoveredBy: z.string(),
    discoveryRunId: z.string(),
    recordedAt: z.string(),
    humanEdits: z.array(z.object({ at: z.string(), by: z.string(), note: z.string() })).default([]),
  }),
  approval: z.object({
    state: z.enum(['draft', 'approved']),
    approvedBy: z.string().optional(),
    replayStats: z.object({
      attempts: z.number().int().min(0),
      successes: z.number().int().min(0),
      lastFailure: z.string().nullable(),
    }),
  }),
})
export type Capability = z.infer<typeof CapabilitySchema>

export const BindingSchema = z.object({
  tenant: z.string().min(1),
  capability: z.string().min(1),
  entryPoint: z.string().url(),
  credentials: z.object({ ref: z.string().regex(/^(env|vault):/, 'credentials must be a env: or vault: reference, never a literal') }).optional(),
  overrides: z.object({ steps: z.record(z.record(z.unknown())).optional() }).default({}),
  driftLog: z
    .array(z.object({ step: z.string(), resolvedVia: z.string(), count: z.number().int(), since: z.string() }))
    .default([]),
})
export type Binding = z.infer<typeof BindingSchema>

export const ReplayResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success'), outputs: z.record(z.unknown()), evidence: z.string() }),
  z.object({ status: z.literal('business_outcome'), code: z.string(), message: z.string(), evidence: z.string() }),
  z.object({ status: z.literal('blocked'), interventionId: z.string(), reason: z.string(), evidence: z.string() }),
  z.object({
    status: z.literal('failed'),
    step: z.string(), expected: z.string(), observed: z.string(),
    class: z.enum(['resolver_not_found', 'resolver_ambiguous', 'checkpoint_failed', 'policy_denied', 'surface_error', 'input_invalid']),
    evidence: z.string(),
  }),
])
export type ReplayResult = z.infer<typeof ReplayResultSchema>

export function capabilityRef(c: Pick<Capability, 'key' | 'version'>): string {
  return `${c.key}@${c.version}`
}
