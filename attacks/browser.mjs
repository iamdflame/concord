// A receipt forge, for firing at the verifier.
//
// Everything here builds *genuinely signed* receipts with real P-256 keys and
// then mutates them the way a coordinator with a motive would. A mutation that
// changes what the receipt means must make verification fail. Anything that
// still verifies is a hole, and the point of this file is to have the holes
// written down as runnable code rather than as a paragraph in a threat model.

import { statement, buildReceipt } from '../concord/receipt.mjs';
import { verifyReceipt } from '../concord/receipt.mjs';
import { canonical } from '../kit/canonical.mjs';

// btoa, not Buffer: this module runs headless in CI and in the attack page.
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

/** A participant with a key that never leaves this process. */
export async function party(vendor, origin = `https://${vendor}.example`) {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  delete publicKey.key_ops; delete publicKey.ext;
  const keyId = b64(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(canonical(publicKey)))).replace(/\W/g, '').slice(0, 16);
  return {
    vendor, origin, keyId,
    record: { keyId, alg: 'ES256', status: 'active', publicKey },
    async sign(s) {
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
        new TextEncoder().encode(canonical(s)));
      return { statement: s, keyId, signature: b64(new Uint8Array(sig)) };
    },
  };
}

/**
 * An honest three-party commitment, signed for real.
 *
 * fly reserves and confirms; stay charges; visa takes a non-refundable fee.
 * Four statements, one plan, every signature valid.
 */
export async function honestReceipt(sagaId = 'saga_forge') {
  const fly = await party('fly');
  const stay = await party('stay');
  const visa = await party('visa');
  const parties = ['fly', 'stay', 'visa'];
  const plan = {
    parties: [...parties].sort(),
    guarantee: 'bounded',
    steps: ['fly.reserve', 'stay.execute', 'visa.execute', 'fly.confirm'],
  };
  const at = '2026-09-02T10:00:00.000Z';
  const make = (p, step, result) => p.sign(statement({
    sagaId, origin: p.origin, vendor: p.vendor, parties, plan, step,
    idempotencyKey: `${sagaId}.${p.vendor}.${step}`, result, at,
  }));

  const entries = [
    await make(fly, 'reserve', { ref: 'NW-AB12' }),
    await make(stay, 'execute', { ref: 'RH-9', minor: 41200, charged: true }),
    await make(visa, 'execute', { ref: 'CF-3', minor: 4700 }),
    await make(fly, 'confirm', { ref: 'NW-AB12', ticketed: true }),
  ];
  const vendors = Object.fromEntries([fly, stay, visa].map((p) =>
    [p.vendor, { origin: p.origin, keyId: p.keyId }]));

  const receipt = await buildReceipt({ sagaId, outcome: 'committed', entries, vendors });
  const keys = new Map([fly, stay, visa].map((p) => [p.origin, p]));

  // Resolves from the origin inside the statement, exactly as the shipped
  // resolver does, so an attack cannot win by pointing at a key it controls.
  const resolve = async (vendor, origin, keyId) => {
    const p = keys.get(origin);
    if (!p) throw new Error(`${origin} publishes no key document`);
    if (p.vendor !== vendor) throw new Error(`${origin} identifies itself as "${p.vendor}"`);
    return p.keyId === keyId ? p.record : null;
  };
  return { receipt, resolve, parties: { fly, stay, visa }, plan };
}

/** Rebuild the tree around whatever entries are left, as a coordinator would. */
export async function rebuild(receipt, entries, outcome = receipt.outcome) {
  return buildReceipt({ sagaId: receipt.sagaId, outcome, entries, vendors: receipt.vendors });
}

export const drop = (receipt, vendor, step) => receipt.entries.filter((e) =>
  !(e.statement.vendor === vendor && e.statement.step === step));

export const ATTACKS = [];
const attack = (name, why, run) => ATTACKS.push({ name, why, run });

// ── the coordinator drops a charge and relabels the outcome ────────────────
// verifyReceipt decides how strict to be from receipt.outcome, which no vendor
// signs. statement() covers sagaId, origin, vendor, parties, plan, step,
// idempotencyKey, at and result. Not the outcome.
for (const outcome of ['committed', 'unwound', 'in-doubt', 'Committed', 'committed ', 'commited', null]) {
  attack(`drop stay.execute, claim ${JSON.stringify(outcome)}`,
    'a $412 charge is removed from the receipt and the outcome relabelled',
    async ({ receipt, resolve }) =>
      verifyReceipt(await rebuild(receipt, drop(receipt, 'stay', 'execute'), outcome), resolve));
}

// ── a whole party is removed ───────────────────────────────────────────────
attack('remove Rowan House entirely, claim "unwound"',
  'every trace of one party is deleted and the tree rebuilt around the rest',
  async ({ receipt, resolve }) => verifyReceipt(
    await rebuild(receipt, receipt.entries.filter((e) => e.statement.vendor !== 'stay'), 'unwound'),
    resolve));

// ── ordinary tampering, which should already fail ──────────────────────────
attack('change what Rowan House charged',
  'one field of one signed statement is edited',
  async ({ receipt, resolve }) => {
    const copy = structuredClone(receipt);
    copy.entries.find((e) => e.statement.vendor === 'stay').statement.result.minor = 1;
    return verifyReceipt(copy, resolve);
  });

attack('swap two signatures',
  'valid signatures, attached to the wrong statements',
  async ({ receipt, resolve }) => {
    const copy = structuredClone(receipt);
    const [a, b] = [copy.entries[0], copy.entries[1]];
    [a.signature, b.signature] = [b.signature, a.signature];
    [a.keyId, b.keyId] = [b.keyId, a.keyId];
    return verifyReceipt(copy, resolve);
  });

attack('replay a statement into another commitment',
  'a statement from one saga is stitched into a receipt for another',
  async ({ receipt, resolve }) => {
    const copy = structuredClone(receipt);
    copy.entries[0].statement.sagaId = 'saga_somewhere_else';
    return verifyReceipt(copy, resolve);
  });

// ── the ledger says one thing and the plan says another ────────────────────
attack('shrink the plan to hide a step',
  'the plan inside every statement is rewritten so the missing step was never planned',
  async ({ receipt, resolve }) => {
    const kept = drop(receipt, 'stay', 'execute');
    // A coordinator cannot re-sign, so it can only drop -- but if it could,
    // this is what it would do. Included to show the signature is what stops it.
    for (const e of kept) {
      e.statement.plan = { ...e.statement.plan, parties: ['fly', 'visa'],
        steps: ['fly.reserve', 'visa.execute', 'fly.confirm'] };
    }
    return verifyReceipt(await rebuild(receipt, kept, 'committed'), resolve);
  });

// ── silence, forged and refused ────────────────────────────────────────────
attack('forge a silence attestation for a party that acted',
  'a "did nothing" statement is invented for the vendor whose charge was removed',
  async ({ receipt, resolve, parties }) => {
    const kept = drop(receipt, 'stay', 'execute');
    // Signed by the wrong party, because the coordinator has no key for stay.
    const forged = await parties.fly.sign({
      ...receipt.entries[0].statement, vendor: 'stay', step: 'none',
      idempotencyKey: `${receipt.sagaId}.stay.none`, result: { happened: false },
    });
    return verifyReceipt(await rebuild(receipt, [...kept, forged], 'unwound'), resolve);
  });

attack('claim a step happened that was never planned',
  'an extra signed statement is added for a step outside the plan',
  async ({ receipt, resolve, parties }) => {
    const extra = await parties.fly.sign({
      ...receipt.entries[0].statement, step: 'upgrade',
      idempotencyKey: `${receipt.sagaId}.fly.upgrade`, result: { minor: 90000 },
    });
    return verifyReceipt(await rebuild(receipt, [...receipt.entries, extra]), resolve);
  });

