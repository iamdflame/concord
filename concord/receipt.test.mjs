import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../kit/canonical.mjs';
import {
  leafHash, buildTree, proofFor, verifyInclusion,
  statement, buildReceipt, verifyReceipt, verifyOwnEntry,
} from './receipt.mjs';

/**
 * Stands in for fetching /.well-known/concord.json, so tests stay offline.
 * Mirrors the real resolver: the origin states which vendor it is, and a
 * mismatch is refused rather than accepted on the coordinator's say-so.
 */
const directory = (origins) => async (vendor, origin, keyId) => {
  const doc = origins[origin];
  if (!doc) throw new Error(`${origin} publishes no concord key document`);
  if (doc.vendor !== vendor) throw new Error(`${origin} identifies itself as "${doc.vendor}", not "${vendor}"`);
  return doc.keys[keyId] ?? null;
};
const PAIR = ['fly.confirm', 'stay.execute'];

const resolver = (byVendor) => async (vendor, origin, keyId) =>
  byVendor[vendor]?.keyId === keyId ? byVendor[vendor].jwk : null;

async function keypair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pair, jwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}

async function sign(privateKey, stmt) {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey,
    new TextEncoder().encode(canonical(stmt)));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

const entryFor = async (kp, vendor, step, result, over = {}) => {
  const parties = over.parties ?? [vendor];
  const stmt = statement({
    sagaId: over.sagaId ?? 's1',
    origin: over.origin ?? `https://${vendor}.example`,
    vendor, parties,
    // Every statement attests to the shape of the whole commitment, not just
    // to this vendor's part of it.
    plan: over.plan ?? { parties: [...parties].sort(), guarantee: 'atomic',
                         steps: over.steps ?? [`${vendor}.${step}`] },
    step, idempotencyKey: `${over.sagaId ?? 's1'}.${vendor}.${step}`,
    at: '2026-09-01T00:00:00Z', result,
  });
  return { statement: stmt, keyId: over.keyId ?? `k-${vendor}`, signature: await sign(kp.pair.privateKey, stmt) };
};

test('every leaf proves inclusion, at every tree size', async () => {
  for (const size of [1, 2, 3, 4, 5, 7, 8, 9]) {
    const leaves = await Promise.all([...Array(size).keys()].map((i) => leafHash({ i })));
    const { root, levels } = await buildTree(leaves);
    for (const [i, leaf] of leaves.entries()) {
      assert.ok(await verifyInclusion(leaf, proofFor(levels, i), root),
        `size ${size}, leaf ${i} failed to prove inclusion`);
    }
  }
});

test('an odd node is promoted, not hashed with a copy of itself', async () => {
  // Duplicating the last leaf is the common shortcut, and it makes [a,b,c] and
  // [a,b,c,c] share a root -- which turns an inclusion proof into a forgery.
  const three = await Promise.all([{ i: 1 }, { i: 2 }, { i: 3 }].map(leafHash));
  const four = [...three, three[2]];
  const a = await buildTree(three);
  const b = await buildTree(four);
  assert.notEqual(a.root, b.root, 'a duplicated tail must not collide with the shorter tree');
});

test('changing any entry changes the root', async () => {
  const kp = await keypair();
  const entries = [await entryFor(kp, 'fly', 'confirm', { minor: 74200 })];
  const resolve = directory({ 'https://fly.example': { vendor: 'fly', keys: { 'k-fly': kp.jwk } } });
  const receipt = await buildReceipt({ sagaId: 's1', outcome: 'committed', entries,
    vendors: { fly: { origin: 'https://fly.example', keyId: 'k-fly' } } });
  assert.equal((await verifyReceipt(receipt, resolve)).ok, true);

  receipt.entries[0].statement.result.minor = 1;
  const after = await verifyReceipt(receipt, resolve);
  assert.equal(after.ok, false);
  // A root mismatch is a complaint about the receipt, not about one party.
  assert.match(after.complaints.join(' '), /do not hash to the stated root/);
});

test('a vendor verifies its own entry without seeing anyone else', async () => {
  const air = await keypair(), hotel = await keypair();
  const entries = [
    await entryFor(air, 'fly', 'confirm', { ref: 'NW1', minor: 74200 }, { parties: ['fly', 'stay'], steps: PAIR }),
    await entryFor(hotel, 'stay', 'execute', { ref: 'RH1', minor: 56700 }, { parties: ['fly', 'stay'], steps: PAIR }),
  ];
  const receipt = await buildReceipt({
    sagaId: 's1', outcome: 'committed', entries,
    vendors: { fly: { origin: 'https://fly.example', keyId: 'k-fly' },
               stay: { origin: 'https://stay.example', keyId: 'k-stay' } } });

  const mine = await verifyOwnEntry({
    entry: receipt.entries[0], proof: receipt.proofs[0], root: receipt.root, jwk: air.jwk });
  assert.equal(mine.ok, true);

  // The proof it was given is opaque hashes. Nothing about the hotel's price
  // is recoverable from it, which is why an airline would accept this at all.
  const disclosed = JSON.stringify(receipt.proofs[0]);
  assert.ok(!disclosed.includes('56700'), 'the proof leaked another vendor\'s amount');
  assert.ok(!disclosed.includes('RH1'), 'the proof leaked another vendor\'s reference');
  assert.ok(receipt.proofs[0].every((p) => /^[0-9a-f]{64}$/.test(p.hash)));
});

test('the coordinator cannot forge a statement it did not receive', async () => {
  const air = await keypair(), coordinator = await keypair();
  // The coordinator invents a favourable entry and signs it with its own key,
  // which is the only key it has. Verification is against the vendor's.
  const forged = { ...(await entryFor(coordinator, 'fly', 'confirm', { minor: 0 })), keyId: 'k-fly' };
  const receipt = await buildReceipt({
    sagaId: 's1', outcome: 'committed', entries: [forged],
    vendors: { fly: { origin: 'https://fly.example', keyId: 'k-fly' } } });

  const out = await verifyReceipt(receipt, resolver({ fly: { keyId: 'k-fly', jwk: air.jwk } }));
  assert.equal(out.ok, false);
  assert.equal(out.findings[0].included, true, 'the entry is in the tree');
  assert.equal(out.findings[0].signed, false, 'but the vendor never said it');
});

test('a valid statement moved to another receipt still fails', async () => {
  const air = await keypair();
  const real = { ...(await entryFor(air, 'fly', 'confirm', { ref: 'NW1' })), keyId: 'k-fly' };
  const receipt = await buildReceipt({
    sagaId: 's1', outcome: 'committed', entries: [real],
    vendors: { fly: { origin: 'https://fly.example', keyId: 'k-fly' } } });
  // Replayed under a different saga: the signature covers sagaId, so it breaks.
  receipt.entries[0].statement.sagaId = 's2';
  assert.equal((await verifyReceipt(receipt, resolver({ fly: { keyId: 'k-fly', jwk: air.jwk } }))).ok, false);
});

test('a receipt with no entries is refused rather than trivially valid', async () => {
  await assert.rejects(() => buildReceipt({ sagaId: 's', outcome: 'committed', entries: [], vendors: {} }));
});

test('a receipt naming a key the vendor does not publish is not verifiable', async () => {
  const air = await keypair();
  const entry = { ...(await entryFor(air, 'fly', 'confirm', { ref: 'NW1' })), keyId: 'rotated-away' };
  const receipt = await buildReceipt({
    sagaId: 's1', outcome: 'committed', entries: [entry],
    vendors: { fly: { origin: 'https://fly.example', keyId: 'rotated-away' } } });

  const out = await verifyReceipt(receipt, resolver({ fly: { keyId: 'k-fly', jwk: air.jwk } }));
  assert.equal(out.ok, false);
  assert.equal(out.findings[0].included, true);
  assert.match(out.findings[0].why, /publishes no key rotated-away/);
});

test('statements from another commitment cannot be stitched into this receipt', async () => {
  const air = await keypair(), hotel = await keypair();
  const receipt = await buildReceipt({ sagaId: 's1', outcome: 'committed', entries: [
    await entryFor(air, 'fly', 'confirm', { ok: true },
      { sagaId: 'last-month', parties: ['fly', 'stay'], steps: PAIR }),
    await entryFor(hotel, 'stay', 'execute', { ok: true }, { parties: ['fly', 'stay'], steps: PAIR }),
  ] });
  const out = await verifyReceipt(receipt, directory({
    'https://fly.example': { vendor: 'fly', keys: { 'k-fly': air.jwk } },
    'https://stay.example': { vendor: 'stay', keys: { 'k-stay': hotel.jwk } },
  }));
  assert.equal(out.ok, false);
  assert.match(out.complaints.join(' '), /from commitment "last-month" appears in a receipt for "s1"/);
});

test('a coordinator cannot name its own origin as the vendor', async () => {
  // The deep one. TLS proves you reached the origin you asked for; only the
  // origin's own document proves that origin is the party being named.
  const evil = await keypair(), hotel = await keypair();
  const receipt = await buildReceipt({ sagaId: 's1', outcome: 'committed', entries: [
    await entryFor(evil, 'fly', 'confirm', { minor: 999999 },
      { origin: 'https://coordinator.example', parties: ['fly', 'stay'], steps: PAIR }),
    await entryFor(hotel, 'stay', 'execute', { ok: true }, { parties: ['fly', 'stay'], steps: PAIR }),
  ] });
  const out = await verifyReceipt(receipt, directory({
    'https://coordinator.example': { vendor: 'coordinator', keys: { 'k-fly': evil.jwk } },
    'https://stay.example': { vendor: 'stay', keys: { 'k-stay': hotel.jwk } },
  }));
  assert.equal(out.ok, false);
  assert.match(out.findings.find((f) => !f.ok).why, /identifies itself as "coordinator", not "fly"/);
});

test('dropping a statement leaves the survivors testifying that one is missing', async () => {
  const air = await keypair(), hotel = await keypair();
  const parties = ['fly', 'stay'];
  const steps = ['fly.confirm', 'stay.execute'];
  const both = [
    await entryFor(air, 'fly', 'confirm', { ok: true }, { parties, steps }),
    await entryFor(hotel, 'stay', 'execute', { minor: 56700 }, { parties, steps }),
  ];
  const dir = directory({
    'https://fly.example': { vendor: 'fly', keys: { 'k-fly': air.jwk } },
    'https://stay.example': { vendor: 'stay', keys: { 'k-stay': hotel.jwk } },
  });

  assert.equal((await verifyReceipt(await buildReceipt(
    { sagaId: 's1', outcome: 'committed', entries: both }), dir)).ok, true);

  const trimmed = await verifyReceipt(await buildReceipt(
    { sagaId: 's1', outcome: 'committed', entries: [both[0]] }), dir);
  assert.equal(trimmed.ok, false);
  assert.match(trimmed.complaints.join(' '), /no statement from stay/);
});

test('statements that disagree about who took part are refused', async () => {
  const air = await keypair(), hotel = await keypair();
  const receipt = await buildReceipt({ sagaId: 's1', outcome: 'committed', entries: [
    await entryFor(air, 'fly', 'confirm', { ok: true }, { parties: ['fly', 'stay'] }),
    await entryFor(hotel, 'stay', 'execute', { ok: true }, { parties: ['fly', 'stay', 'visa'] }),
  ] });
  const out = await verifyReceipt(receipt, directory({
    'https://fly.example': { vendor: 'fly', keys: { 'k-fly': air.jwk } },
    'https://stay.example': { vendor: 'stay', keys: { 'k-stay': hotel.jwk } },
  }));
  assert.equal(out.ok, false);
  assert.match(out.complaints.join(' '), /disagree about what this commitment was going to be/);
});

test('a root mismatch still reports per entry, not one generic failure', async () => {
  // The README promised the receipt names the bad statement rather than
  // collapsing into "invalid". The early return meant it collapsed.
  const air = await keypair();
  const receipt = await buildReceipt({ sagaId: 's1', outcome: 'committed',
    entries: [await entryFor(air, 'fly', 'confirm', { minor: 74200 })] });
  receipt.entries[0].statement.result.minor = 1;
  const out = await verifyReceipt(receipt, directory({
    'https://fly.example': { vendor: 'fly', keys: { 'k-fly': air.jwk } } }));
  assert.equal(out.ok, false);
  assert.match(out.complaints.join(' '), /do not hash to the stated root/);
  assert.equal(out.findings.length, 1, 'per-entry detail must survive a root mismatch');
  assert.equal(out.findings[0].vendor, 'fly');
});

// ── key validity ───────────────────────────────────────────────────────────
// A signature that verifies is not the same as a signature that counts.

const record = (jwk, over = {}) => ({ keyId: 'k-fly', alg: 'ES256', publicKey: jwk,
  notBefore: '2026-01-01T00:00:00Z', status: 'active', ...over });

const receiptDated = async (kp, at) => {
  const stmt = statement({ sagaId: 's1', origin: 'https://fly.example', vendor: 'fly',
    parties: ['fly'], plan: { parties: ['fly'], guarantee: 'atomic', steps: ['fly.confirm'] },
    step: 'confirm', idempotencyKey: 's1.fly.confirm', at, result: { ok: true } });
  return buildReceipt({ sagaId: 's1', outcome: 'committed',
    entries: [{ statement: stmt, keyId: 'k-fly', signature: await sign(kp.pair.privateKey, stmt) }] });
};
const withKey = (rec) => async (vendor, origin, keyId) =>
  origin === 'https://fly.example' && keyId === 'k-fly' ? rec : null;

test('a key retired before the statement is dated cannot have signed it', async () => {
  const kp = await keypair();
  const out = await verifyReceipt(await receiptDated(kp, '2026-06-01T00:00:00Z'),
    withKey(record(kp.jwk, { status: 'rotated', retiredAt: '2026-03-01T00:00:00Z' })));
  assert.equal(out.ok, false);
  assert.equal(out.findings[0].inForce, false);
  assert.match(out.findings[0].why, /retired on 2026-03-01/);
});

test('a rotated key still vouches for what it signed while it was live', async () => {
  const kp = await keypair();
  const out = await verifyReceipt(await receiptDated(kp, '2026-02-01T00:00:00Z'),
    withKey(record(kp.jwk, { status: 'rotated', retiredAt: '2026-03-01T00:00:00Z' })));
  assert.equal(out.ok, true, 'retiring a key must not invalidate honest history');
});

test('a key reported compromised proves nothing after the moment it was taken', async () => {
  // This is what "the receipt still verifies in a year" costs: without it, the
  // holder of a stolen key forges the whole history and no one can object.
  const kp = await keypair();
  const compromised = record(kp.jwk, { status: 'compromised', compromisedSince: '2026-04-01T00:00:00Z' });

  const after = await verifyReceipt(await receiptDated(kp, '2026-06-01T00:00:00Z'), withKey(compromised));
  assert.equal(after.ok, false);
  assert.match(after.findings[0].why, /compromised since 2026-04-01/);

  const before = await verifyReceipt(await receiptDated(kp, '2026-02-01T00:00:00Z'), withKey(compromised));
  assert.equal(before.ok, true, 'statements made before the compromise still stand');
});

test('a statement dated before its key existed is refused', async () => {
  const kp = await keypair();
  const out = await verifyReceipt(await receiptDated(kp, '2025-06-01T00:00:00Z'), withKey(record(kp.jwk)));
  assert.equal(out.ok, false);
  assert.match(out.findings[0].why, /did not exist until/);
});

test('a statement with no usable timestamp cannot be placed in any key window', async () => {
  const kp = await keypair();
  const out = await verifyReceipt(await receiptDated(kp, undefined), withKey(record(kp.jwk)));
  assert.equal(out.ok, false);
  assert.match(out.findings[0].why, /no usable timestamp/);
});

test('a coordinator cannot hide one of a vendor\'s own statements', async () => {
  // The attack the party list could not see. fly.confirm is the statement
  // proving the flight was ticketed and charged. Drop it, rebuild the receipt
  // around what is left, and every party is still represented -- so nothing
  // objected, while the receipt hid that money moved.
  const air = await keypair(), hotel = await keypair();
  const parties = ['fly', 'stay'];
  const steps = ['fly.reserve', 'fly.confirm', 'stay.execute'];
  const all = [
    await entryFor(air, 'fly', 'reserve', { ref: 'NW1' }, { parties, steps }),
    await entryFor(hotel, 'stay', 'execute', { minor: 56700 }, { parties, steps }),
    await entryFor(air, 'fly', 'confirm', { minor: 74200 }, { parties, steps }),
  ];
  const dir = directory({
    'https://fly.example': { vendor: 'fly', keys: { 'k-fly': air.jwk } },
    'https://stay.example': { vendor: 'stay', keys: { 'k-stay': hotel.jwk } },
  });

  assert.equal((await verifyReceipt(await buildReceipt(
    { sagaId: 's1', outcome: 'committed', entries: all }), dir)).ok, true);

  // Rebuilt properly, root and all -- the way anyone competent would do it.
  const hidden = await buildReceipt({
    sagaId: 's1', outcome: 'committed',
    entries: all.filter((e) => e.statement.step !== 'confirm'),
  });
  const out = await verifyReceipt(hidden, dir);
  assert.equal(out.ok, false);
  assert.match(out.complaints.join(' '), /claims to have committed, but fly\.confirm/);
});

test('an honest unwound receipt is not failed for the steps that never ran', async () => {
  // A commitment that unwound genuinely has no confirm statement. Failing it
  // for that would make every honest failure look like a forgery.
  const air = await keypair();
  const steps = ['fly.reserve', 'fly.confirm'];
  const entries = [
    await entryFor(air, 'fly', 'reserve', { ref: 'NW1' }, { parties: ['fly'], steps }),
    await entryFor(air, 'fly', 'cancel', { released: true }, { parties: ['fly'], steps }),
  ];
  const out = await verifyReceipt(
    await buildReceipt({ sagaId: 's1', outcome: 'unwound', entries }),
    directory({ 'https://fly.example': { vendor: 'fly', keys: { 'k-fly': air.jwk } } }));

  assert.equal(out.ok, true, 'an unwound commitment must still verify');
  assert.match(out.notes.join(' '), /fly\.confirm never happened/);
  assert.equal(out.complaints.length, 0);
});
