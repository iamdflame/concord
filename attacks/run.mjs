#!/usr/bin/env node
// Fire every forgery at the verifier and report which ones it lets through.
//
//   node attacks/run.mjs
//
// Exit code is the number of attacks that succeeded. Zero is the only
// acceptable answer for a project whose pitch is that a receipt can be checked
// by somebody who trusts neither party.

import { verifyReceipt } from '../concord/receipt.mjs';
import { honestReceipt, rebuild, drop } from './forge.mjs';

const attacks = [];
const attack = (name, why, run) => attacks.push({ name, why, run });

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

const honest = await honestReceipt();

// The control. If this fails, the harness is wrong, not the verifier.
const control = await verifyReceipt(honest.receipt, honest.resolve);
console.log(`\n  control: an honest receipt ${control.ok ? 'verifies ✓' : 'FAILS ✗ — the harness is broken'}`);
if (!control.ok) { console.log(control.complaints.join('\n')); process.exit(2); }

let through = 0;
console.log(`\n  ${attacks.length} attacks\n`);
for (const { name, why, run } of attacks) {
  const v = await run(honest);
  const stopped = !v.ok;
  if (!stopped) through++;
  console.log(`  ${stopped ? '✓ rejected' : '✗ ACCEPTED'}  ${name}`);
  if (!stopped) console.log(`               ${why}`);
  else if (process.env.VERBOSE) console.log(`               ${(v.complaints[0] ?? '').slice(0, 96)}`);
}

console.log(through
  ? `\n${through} of ${attacks.length} attacks were accepted by the verifier.`
  : `\nAll ${attacks.length} attacks rejected.`);
process.exit(through);
