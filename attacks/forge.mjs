// A receipt forge, for firing at the verifier.
//
// Everything here builds *genuinely signed* receipts with real P-256 keys and
// then mutates them the way a coordinator with a motive would. A mutation that
// changes what the receipt means must make verification fail. Anything that
// still verifies is a hole, and the point of this file is to have the holes
// written down as runnable code rather than as a paragraph in a threat model.

import { statement, buildReceipt } from '../concord/receipt.mjs';
import { canonical } from '../kit/canonical.mjs';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

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
