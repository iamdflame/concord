// The gaps mutation testing found.
//
// `npm run mutants` changes the code in ways that must break something, and
// reports the changes nothing noticed. Every test below closes one of those.
// They are collected here rather than scattered because what they have in
// common is the point: all of them are *boundaries* -- the exact moment a key
// starts being valid, the exact moment it is reported stolen, the index one
// past the end -- and boundaries are where a real dispute lands. A suite that
// only ever tests the middle of a range is a suite that agrees with the code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyValidAt, proofFor, buildTree, leafHash, verifyOwnEntry, verifyReceipt,
         buildReceipt, statement } from './receipt.mjs';

const KEY = { keyId: 'k', alg: 'ES256', status: 'active',
              publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } };

test('a key is valid at the instant it comes into force, and not before', () => {
  // `at < notBefore` rejects. The mutant made it `at <= notBefore`, which
  // rejects a statement dated at exactly the moment the key was created --
  // and nothing noticed, because every test used a date comfortably inside
  // the window.
  const record = { ...KEY, notBefore: '2026-01-01T00:00:00.000Z' };
  assert.equal(keyValidAt(record, '2026-01-01T00:00:00.000Z').ok, true,
    'the instant it comes into force is inside its life');
  assert.equal(keyValidAt(record, '2025-12-31T23:59:59.999Z').ok, false,
    'one millisecond before it existed is not');
});

test('a compromised key is worthless from the instant it is reported, inclusive', () => {
  // `at >= compromisedSince` rejects. The mutant made it `>`, which accepts a
  // statement dated at exactly the reported moment. That is the wrong side of
  // the line to be generous on: the report says "from here, this proves
  // nothing", and a signature made in that same instant is precisely what
  // somebody would produce.
  const record = { ...KEY, status: 'compromised', compromisedSince: '2026-06-01T12:00:00.000Z' };
  assert.equal(keyValidAt(record, '2026-06-01T12:00:00.000Z').ok, false,
    'the instant it was reported stolen is already too late');
  assert.equal(keyValidAt(record, '2026-06-01T11:59:59.999Z').ok, true,
    'and a millisecond earlier still counts');
  assert.match(keyValidAt(record, '2026-06-01T12:00:00.000Z').why, /compromised/);
});

test('a proof cannot be cut for a leaf one past the end', async () => {
  const leaves = await Promise.all([0, 1, 2].map((i) => leafHash({ i })));
  await assert.rejects(() => proofFor(leaves, 3), RangeError,
    'index === length is out of range, not the last leaf');
  await assert.rejects(() => proofFor(leaves, -1), RangeError);
  assert.ok(await proofFor(leaves, 2), 'and the actual last leaf still works');
});

test('a vendor checking its own entry is told about a key that was not in force', async () => {
  // verifyOwnEntry had no window check at all until an audit found it, and
  // then had one with no test -- a mutant loosening `signed && window.ok` to
  // `||` survived. A vendor checking its own entry must get the same answer
  // as everybody else, not a cheerier one.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' },
    true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  delete jwk.key_ops; delete jwk.ext;

  const stmt = statement({ sagaId: 's', origin: 'https://a.example', vendor: 'a',
    parties: ['a'], plan: { parties: ['a'], steps: ['a.execute'] }, step: 'execute',
    idempotencyKey: 's.a.execute', at: '2026-06-02T00:00:00.000Z', result: { ok: true } });
  const { canonical } = await import('../kit/canonical.mjs');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
    new TextEncoder().encode(canonical(stmt)));
  const entry = { statement: stmt, keyId: 'k',
    signature: btoa(String.fromCharCode(...new Uint8Array(sig))) };

  const leaves = [await leafHash(entry)];
  const { root } = await buildTree(leaves);
  const proof = await proofFor(leaves, 0);

  const live = await verifyOwnEntry({ entry, proof, root,
    jwk: { keyId: 'k', alg: 'ES256', status: 'active', publicKey: jwk } });
  assert.equal(live.ok, true, 'an in-force key verifies');

  const stolen = await verifyOwnEntry({ entry, proof, root,
    jwk: { keyId: 'k', alg: 'ES256', status: 'compromised',
           compromisedSince: '2026-06-01T00:00:00.000Z', publicKey: jwk } });
  assert.equal(stolen.ok, false, 'a key reported stolen before this statement does not');
  assert.equal(stolen.signed, false, 'and the signature is not reported as good');
  assert.equal(stolen.inForce, false);
  assert.match(stolen.why, /compromised/);
});

test('a step nobody planned is a complaint even when everything else adds up', async () => {
  // The stray-step guard had no test: emptying it changed nothing anybody
  // checked. It is the rule that stops a coordinator adding a signed step the
  // commitment never contained.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' },
    true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  delete jwk.key_ops; delete jwk.ext;
  const { canonical } = await import('../kit/canonical.mjs');

  const plan = { parties: ['a'], steps: ['a.execute'] };
  const sign = async (step) => {
    const stmt = statement({ sagaId: 's', origin: 'https://a.example', vendor: 'a',
      parties: ['a'], plan, step, idempotencyKey: `s.a.${step}`,
      at: '2026-06-02T00:00:00.000Z', result: { ok: true } });
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
      new TextEncoder().encode(canonical(stmt)));
    return { statement: stmt, keyId: 'k',
      signature: btoa(String.fromCharCode(...new Uint8Array(sig))) };
  };
  const resolve = async () => ({ keyId: 'k', alg: 'ES256', status: 'active', publicKey: jwk });

  const honest = await verifyReceipt(await buildReceipt({ sagaId: 's', outcome: 'committed',
    entries: [await sign('execute')] }), resolve);
  assert.equal(honest.ok, true, honest.complaints.join('; '));

  const padded = await verifyReceipt(await buildReceipt({ sagaId: 's', outcome: 'committed',
    entries: [await sign('execute'), await sign('upgrade')] }), resolve);
  assert.equal(padded.ok, false, 'a signed step outside the plan must be refused');
  assert.match(padded.complaints.join(' '), /a\.upgrade is not a step this commitment was planned/);
});

test('a handle returned as a bare string is still a handle', async () => {
  // saga.mjs derives the reference a later step names from whatever a vendor
  // returned: a string is the reference, an object carries it in `.ref`. The
  // string branch had no test, so inverting the check survived -- and a
  // participant that answers `"NW-AB12"` rather than `{ ref: "NW-AB12" }`
  // would have had its handle read as null.
  const { handleForTest } = await import('./saga.mjs');
  assert.equal(handleForTest('NW-AB12'), 'NW-AB12');
  assert.equal(handleForTest({ ref: 'NW-AB12' }), 'NW-AB12');
  assert.equal(handleForTest({ nothing: true }), null);
  assert.equal(handleForTest(null), null);
});
