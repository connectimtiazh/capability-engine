export interface Member {
  memberId: string
  name: string
  savingsBalance: number
  restricted: boolean
}

const MEMBERS: Member[] = [
  { memberId: '40021', name: 'A. Whitfield', savingsBalance: 1284.55, restricted: false },
  { memberId: '40022', name: 'R. Delacroix', savingsBalance: 9902.10, restricted: true },
  { memberId: '40023', name: 'M. Okonkwo', savingsBalance: 312.00, restricted: false },
]

export type Lookup =
  | { kind: 'found'; member: Member }
  | { kind: 'restricted' }
  | { kind: 'not_found' }

export function lookup(memberId: string): Lookup {
  const m = MEMBERS.find((x) => x.memberId === memberId)
  if (!m) return { kind: 'not_found' }
  if (m.restricted) return { kind: 'restricted' }
  return { kind: 'found', member: m }
}

export const AS_OF = '2026-09-17'
