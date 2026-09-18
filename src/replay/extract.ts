export type ExtractResult =
  | { ok: true; value: string | number }
  | { ok: false; observed: string }

/** Reads the value beside a label on a table-built screen and coerces it to the declared
 *  type. The model chose the label at compile time; replay only executes the lookup, so the
 *  same capability returns a number for every member rather than a screen of text.
 *
 *  Cells in Chromium's innerText are tab-separated within a row, so the value is whatever
 *  follows the label on its line. */
export function extractAnchored(
  text: string,
  rowHeader: string,
  as: 'string' | 'number' | 'date',
): ExtractResult {
  const lines = text.split('\n').map((l) => l.trim())
  const isLabel = (cell: string): boolean => cell.trim().replace(/:$/, '') === rowHeader
  let raw: string | undefined
  const exact = lines.find((l) => isLabel(l.split('\t')[0] ?? ''))
  if (exact) {
    raw = exact.split('\t')[1]?.trim()
  } else {
    const loose = lines.find((l) => l.startsWith(rowHeader) && /^[\s:]/.test(l.slice(rowHeader.length)))
    if (loose) raw = loose.slice(rowHeader.length).replace(/^[\s:]+/, '').split('\t')[0]!.trim()
  }
  if (raw === undefined) return { ok: false, observed: `no row labelled "${rowHeader}" on screen` }
  if (!raw) return { ok: false, observed: `"${rowHeader}" present but no value beside it` }

  if (as === 'number') {
    const cleaned = raw.replace(/[^0-9.\-]/g, '')
    const n = Number(cleaned)
    if (!cleaned || Number.isNaN(n)) return { ok: false, observed: `"${raw}" is not a number` }
    return { ok: true, value: n }
  }
  if (as === 'date') {
    const m = raw.match(/\d{4}-\d{2}-\d{2}/)
    if (!m) return { ok: false, observed: `"${raw}" is not an ISO date` }
    return { ok: true, value: m[0] }
  }
  return { ok: true, value: raw }
}
