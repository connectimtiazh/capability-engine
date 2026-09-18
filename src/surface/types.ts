export interface A11yNode {
  role: string
  name: string
  nameAttr?: string
  labelText?: string
  framePath: string[]
  ref: string
}

export interface FrameSnapshot {
  path: string[]
  nodes: A11yNode[]
  text: string
}

export interface Observation {
  url: string
  title: string
  frames: FrameSnapshot[]
}

export type Resolution =
  | { kind: 'one'; node: A11yNode; via: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }

export class PolicyError extends Error {
  constructor(
    readonly verdict: 'HOLD' | 'DENY',
    readonly reason: string,
  ) {
    super(`policy ${verdict}: ${reason}`)
    this.name = 'PolicyError'
  }
}
