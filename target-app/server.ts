import express from 'express'
import type { Server } from 'node:http'
import { lookup, AS_OF } from './data.js'

type Inject = 'motd' | 'session-timeout' | 'unknown-dialog' | 'slow' | 'slow-inquire' | 'slow-frame' | undefined

const chrome = (body: string) => `<html><head><title>QuestCore 8.3</title></head>
<body bgcolor="#EFEFEF"><table width="100%" cellpadding="4" cellspacing="0" border="0">
<tr><td bgcolor="#1F3A5F"><font color="#FFFFFF" size="2"><b>QuestCore Member Services 8.3</b></font></td></tr>
<tr><td>${body}</td></tr></table></body></html>`

const dialog = (title: string, text: string) => `
<table border="1" cellpadding="8" cellspacing="0" bgcolor="#FFFFCC" width="420">
  <tr><td><font size="2"><b>${title}</b></font></td></tr>
  <tr><td><font size="2">${text}</font></td></tr>
  <tr><td><form method="get" action="/member/search">
    <input type="submit" value="Acknowledge"></form></td></tr>
</table>`

// `slowInquire` mirrors `?inject=slow` but on the mid-flow POST rather than the
// initial GET: the form's own action carries the query string forward, so a
// capability's "click Inquire" step — not its initial page load — is what hits
// the delayed response. That is what a per-step timeoutMs actually needs to be
// tested against: a step budget, not the one-time page navigation before any
// step runs.
const searchForm = (slowInquire?: boolean) => `
<form method="post" action="/member/inquire${slowInquire ? '?inject=slow' : ''}">
<table cellpadding="3" cellspacing="0" border="0">
  <tr>
    <td nowrap><font size="2">Member No.</font></td>
    <td><input type="text" name="ctl00$mbrNo" size="12"></td>
    <td><input type="submit" name="ctl00$btnInquire" value="Inquire"></td>
  </tr>
  <tr><td colspan="3"><font size="1" color="#666666">Enter a member number and select Inquire.</font></td></tr>
</table>
</form>`

export function createServer(): Server {
  const app = express()
  app.use(express.urlencoded({ extended: false }))

  app.get('/health', (_req, res) => { res.json({ ok: true }) })

  app.get('/', (req, res) => {
    // F52: `?inject=slow-frame` forces the frame race a frameset always risks —
    // the "main" child frame's own load lags behind the parent frameset document's
    // domcontentloaded — by delaying only the child's request, never the parent's.
    // Carried on the frame's own `src` (the child issues a separate navigation),
    // exactly like `slowInquire` carries `?inject=slow` on the form's own action.
    const slowFrame = (req.query.inject as Inject) === 'slow-frame'
    res.type('html').send(`<html><head><title>QuestCore 8.3</title></head>
<frameset rows="70,*" border="1">
  <frame src="/nav" name="nav">
  <frame src="/member/search${slowFrame ? '?inject=slow-frame' : ''}" name="main">
</frameset></html>`)
  })

  app.get('/nav', (_req, res) => {
    res.type('html').send(chrome(`<font size="2">Member Services &nbsp;|&nbsp; Teller &nbsp;|&nbsp; Reports</font>`))
  })

  app.get('/member/search', async (req, res) => {
    const inject = req.query.inject as Inject
    if (inject === 'slow') await new Promise((r) => setTimeout(r, 3000))
    // F52: a step's default timeout-recovery rung (max 2, backoffMs 500) only
    // covers roughly 1s of "wait and recheck" before giving up — measured directly
    // (see wave3-report.md): the "main" frame's name/URL do not appear in
    // page.frames() until the response actually lands, so anything short of that
    // ~1s cushion would pass by accident regardless of whether open() waits. 3s is
    // comfortably past it, so this only survives if the entry navigation itself
    // waits for the child frame.
    if (inject === 'slow-frame') await new Promise((r) => setTimeout(r, 3000))
    if (inject === 'session-timeout') {
      return res.type('html').send(chrome(
        `<font size="2" color="#AA0000"><b>Your session has expired.</b></font>
         <br><form method="get" action="/member/search"><input type="submit" value="Sign in again"></form>`))
    }
    if (inject === 'motd') {
      return res.type('html').send(chrome(dialog('Message of the Day', 'Scheduled maintenance Sunday 02:00-04:00 ET.')))
    }
    if (inject === 'unknown-dialog') {
      return res.type('html').send(chrome(dialog('Compliance Notice', 'Quarterly attestation is now due for this workstation.')))
    }
    res.type('html').send(chrome(searchForm(inject === 'slow-inquire')))
  })

  app.post('/member/inquire', async (req, res) => {
    if ((req.query.inject as Inject) === 'slow') await new Promise((r) => setTimeout(r, 3000))
    const raw = (req.body['ctl00$mbrNo'] ?? '') as string
    const memberId = raw.trim()
    const result = lookup(memberId)

    if (result.kind === 'not_found') {
      return res.type('html').send(chrome(
        `<font size="2" color="#AA0000"><b>No record found</b></font><br><br>${searchForm()}`))
    }
    if (result.kind === 'restricted') {
      return res.type('html').send(chrome(
        `<font size="2" color="#AA0000"><b>Access restricted</b></font>
         <br><font size="1">This member requires elevated entitlements.</font><br><br>${searchForm()}`))
    }

    const m = result.member
    res.type('html').send(chrome(`
<table cellpadding="3" cellspacing="0" border="0">
  <tr><td nowrap><font size="2">Member</font></td><td><font size="2">${m.name} (${m.memberId})</font></td></tr>
  <tr><td nowrap><font size="2">Share Balance</font></td><td><font size="2">${m.savingsBalance.toFixed(2)}</font></td></tr>
  <tr><td nowrap><font size="2">As Of</font></td><td><font size="2">${AS_OF}</font></td></tr>
</table><br>${searchForm()}`))
  })

  return app as unknown as Server & express.Express
}

const isMain = process.argv[1]?.endsWith('server.ts')
if (isMain) {
  const port = Number(process.env.PORT ?? 4000)
  ;(createServer() as unknown as express.Express).listen(port, () => {
    console.log(`target-app listening on http://localhost:${port}`)
  })
}
