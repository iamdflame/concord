import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../kit/canonical.mjs';
import {
  leafHash, buildTree, proofFor, verifyInclusion,
  statement, buildReceipt, verifyReceipt, verifyOwnEntry,
} from './receipt.mjs';

/** Stands in for fetching /.well-known/concord.json, so tests stay offline. */
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

const entryFor = async (kp, vendor, step, result) => {
  const stmt = statement({ sagaId: 's1', vendor, step, idempotencyKey: `s1.${vendor}.${step}`, result });
  return { statement: stmt, signature: await sign(kp.pair.privateKey, stmt) };
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
  const entries = [{ ...(await entryFor(kp, 'fly', 'confirm', { minor: 74200 })), keyId: 'k-fly' }];
  const resolve = resolver({ fly: { keyId: 'k-fly', jwk: kp.jwk } });
  const receipt = await buildReceipt({ sagaId: 's1', outcome: 'committed', entries,
    vendors: { fly: { origin: 'https://fly.example', keyId: 'k-fly' } } });
  assert.equal((await verifyReceipt(receipt, resolve)).ok, true);

  receipt.entries[0].statement.result.minor = 1;
  const after = await verifyReceipt(receipt, resolve);
  assert.equal(after.ok, false);
  assert.match(after.findings[0].why ?? '', /do not hash to the stated root/);
});

test('a vendor verifies its own entry without seeing anyone else', async () => {
  const air = await keypair(), hotel = await keypair();
  const entries = [
    await entryFor(air, 'fly', 'confirm', { ref: 'NW1', minor: 74200 }),
    await entryFor(hotel, 'stay', 'execute', { ref: 'RH1', minor: 56700 }),
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
