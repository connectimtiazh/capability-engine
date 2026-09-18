import { describe, it, expect } from 'vitest'
import { SYSTEM_PROMPT } from '../src/discover/prompt.js'

describe('SYSTEM_PROMPT', () => {
  it('asks the model to author a label anchor for every extraction', () => {
    expect(SYSTEM_PROMPT).toContain('rowHeader')
    expect(SYSTEM_PROMPT).toMatch(/LABEL next to the value/)
  })
})
