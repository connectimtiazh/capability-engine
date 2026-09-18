import type { ActionKind, TargetDescriptor } from '../capability/schema.js'
import type { Observation } from '../surface/types.js'

export interface ProposeInput {
  goal: string
  observation: Observation
  history: string[]
}

export type ProposedAction =
  | { kind: 'act'; action: ActionKind; target: TargetDescriptor; value?: string; intent: string }
  | { kind: 'extract'; name: string; as: 'string' | 'number' | 'date'; from: TargetDescriptor; intent: string }
  | { kind: 'done'; summary: string }
  | { kind: 'stuck'; why: string }

export interface ModelClient {
  readonly name: string
  propose(input: ProposeInput): Promise<ProposedAction>
}

/** Injected into replay tests. If replay ever reaches for a model, the test fails
 *  loudly rather than silently costing money and determinism. */
export class ThrowingModel implements ModelClient {
  readonly name = 'throwing'
  async propose(): Promise<ProposedAction> {
    throw new Error('a model was called during replay — the decision loop must be model-free')
  }
}

export class OpenRouterModel implements ModelClient {
  readonly name: string
  constructor(
    private readonly apiKey = process.env.OPENROUTER_API_KEY ?? '',
    model = process.env.DISCOVERY_MODEL ?? 'anthropic/claude-opus-4.1',
  ) {
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is not set')
    this.name = model
  }

  async propose(input: ProposeInput): Promise<ProposedAction> {
    const { SYSTEM_PROMPT, renderObservation } = await import('./prompt.js')
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.name,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `GOAL: ${input.goal}\n\nSTEPS SO FAR:\n${input.history.join('\n') || '(none)'}\n\nCURRENT SCREEN:\n${renderObservation(input.observation)}`,
          },
        ],
      }),
    })
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    const text = body.choices?.[0]?.message?.content ?? ''
    try {
      return JSON.parse(text) as ProposedAction
    } catch {
      throw new Error(`model returned unparseable JSON: ${text.slice(0, 500)}`)
    }
  }
}
