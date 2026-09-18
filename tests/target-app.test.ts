import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { createServer } from '../target-app/server.js'

let server: Server
const base = 'http://localhost:4111'

beforeAll(async () => {
  server = createServer().listen(4111)
  await new Promise((r) => server.once('listening', r))
})
afterAll(() => new Promise((r) => server.close(() => r(undefined))))

describe('hostile target app', () => {
  it('serves a frameset at the root with a main frame', async () => {
    const html = await (await fetch(base + '/')).text()
    expect(html).toContain('<frameset')
    expect(html).toContain('name="main"')
  })

  it('renders the search form with no ids and no test ids', async () => {
    const html = await (await fetch(base + '/member/search')).text()
    expect(html).toContain('ctl00$mbrNo')
    expect(html).not.toMatch(/data-testid/)
    expect(html).not.toMatch(/\bid="/)
    expect(html).toContain('<table')
  })

  it('returns a balance for a known member', async () => {
    const res = await fetch(base + '/member/inquire', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ctl00%24mbrNo=40021',
    })
    const html = await res.text()
    expect(html).toContain('Share Balance')
    expect(html).toContain('1284.55')
  })

  it('says no record found for an unknown member', async () => {
    const res = await fetch(base + '/member/inquire', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ctl00%24mbrNo=99999',
    })
    expect(await res.text()).toContain('No record found')
  })

  it('says access restricted for a restricted member', async () => {
    const res = await fetch(base + '/member/inquire', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ctl00%24mbrNo=40022',
    })
    expect(await res.text()).toContain('Access restricted')
  })

  it('injects a session timeout when asked', async () => {
    const res = await fetch(base + '/member/search?inject=session-timeout')
    expect(await res.text()).toContain('Your session has expired')
  })

  it('injects an unknown dialog when asked', async () => {
    const res = await fetch(base + '/member/search?inject=unknown-dialog')
    expect(await res.text()).toContain('Compliance Notice')
  })
})
