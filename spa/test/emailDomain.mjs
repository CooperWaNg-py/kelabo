// Domain completion on the sign-in page (spa/src/emailDomain.js).
//
// The property that matters: whatever the participant types, the address that
// leaves the page has exactly one "@" and the deployment's domain — or it is
// refused here, with a reason, instead of costing a 403 round-trip.
import assert from 'node:assert/strict'
import { normaliseDomain, resolveEmail } from '../src/emailDomain.js'

const D = 'acme.com'

// --- normaliseDomain ------------------------------------------------------
assert.equal(normaliseDomain('acme.com'), 'acme.com')
assert.equal(normaliseDomain('  ACME.com  '), 'acme.com', 'trimmed and folded')
assert.equal(normaliseDomain('@acme.com'), 'acme.com', 'a leading @ in config is tolerated')
assert.equal(normaliseDomain(''), '', 'empty = open registration')
assert.equal(normaliseDomain(undefined), '', 'absent = open registration')
assert.equal(normaliseDomain(null), '')
assert.equal(normaliseDomain('   '), '', 'whitespace-only = open registration')

// --- locked domain: the point of the feature ------------------------------
{
  const r = resolveEmail('rico', D)
  assert.equal(r.ok, true)
  assert.equal(r.email, 'rico@acme.com', 'bare local part is completed')
  assert.equal(r.completed, true)
}
{
  const r = resolveEmail('  rico  ', D)
  assert.equal(r.email, 'rico@acme.com', 'surrounding whitespace is trimmed first')
}
{
  const r = resolveEmail('rico@', D)
  assert.equal(r.ok, true)
  assert.equal(r.email, 'rico@acme.com', 'a trailing @ is finished, not doubled')
  assert.equal(r.completed, true)
}

// A full, correct address survives untouched — this is the autofill/paste
// path, and the regression a naive suffix-append would cause.
{
  const r = resolveEmail('rico@acme.com', D)
  assert.equal(r.ok, true)
  assert.equal(r.email, 'rico@acme.com')
  assert.equal(r.completed, false, 'nothing was added')
}
assert.equal(
  resolveEmail('rico@acme.com', D).email.split('@').length - 1, 1,
  'never rico@acme.com@acme.com',
)
{
  const r = resolveEmail('Rico@ACME.com', D)
  assert.equal(r.ok, true, 'domain compares case-insensitively')
  assert.equal(r.email, 'Rico@ACME.com', 'the local part is never case-folded')
}

// Wrong domain is caught here rather than by the server's 403.
for (const bad of ['eve@gmail.com', 'eve@notacme.com', 'eve@sub.acme.com', 'eve@acme.com.evil.io']) {
  const r = resolveEmail(bad, D)
  assert.equal(r.ok, false, `${bad} refused`)
  assert.equal(r.reason, 'wrong_domain', `${bad} -> wrong_domain`)
}

// Malformed input is refused, never patched up.
for (const bad of ['@acme.com', '@', 'a@b@acme.com', 'rico@acme.com@acme.com']) {
  const r = resolveEmail(bad, D)
  assert.equal(r.ok, false, `${bad} refused`)
  assert.equal(r.reason, 'not_an_email', `${bad} -> not_an_email`)
}
for (const empty of ['', '   ', null, undefined]) {
  assert.equal(resolveEmail(empty, D).reason, 'empty')
}

// --- unlocked (open registration): prior behaviour is unchanged -----------
{
  const r = resolveEmail('rico', '')
  assert.equal(r.ok, false, 'no domain to guess with')
  assert.equal(r.reason, 'not_an_email')
}
assert.equal(resolveEmail('rico@', '').ok, false, 'nothing to complete a trailing @ with')
{
  const r = resolveEmail('eve@gmail.com', '')
  assert.equal(r.ok, true, 'any domain is allowed when none is configured')
  assert.equal(r.email, 'eve@gmail.com')
  assert.equal(r.completed, false)
}
assert.equal(resolveEmail('a@b@c.com', '').reason, 'not_an_email')

console.log('emailDomain: ok')
