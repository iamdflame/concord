// A receipt fuzzer.
//
// attacks/ contains the forgeries a person thought of. This generates them:
// build an honest receipt, apply one structured mutation, and require that any
// mutation which changes what the receipt *means* is rejected. Several hundred
// cases per run, deterministic, replayable with SEED=<n>.
//
// The distinction that matters is between mutations that change meaning and
// mutations that do not. Reordering the entries of a Merkle receipt changes
// the tree, so it must fail; renaming a field nothing reads changes nothing,
// so it must not. Getting that boundary wrong in either direction is a bug --
// a verifier that rejects everything is as useless as one that accepts
// everything, and only the first looks safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forAll, int, pick, record, rng } from '../kit/property.mjs';
import { verifyReceipt } from '../concord/receipt.mjs';
import { honestReceipt, rebuild } from './browser.mjs';

/** One honest receipt, reused: generating keys per case is the slow part. */
const base = await honestReceipt('saga_fuzz');

/**
 * Mutations that change what a receipt asserts. Every one must be rejected.
 *
 * Each returns null when it does not apply to this receipt, which the loop
 * skips rather than counting as a pass.
 */
const MEANINGFUL = {
  'drop a statement': (r, cp) => {
    if (cp.entries.length < 2) return null;
    cp.entries.splice(int(0, cp.entries.length - 1)(r), 1);
    return cp;
  },
  'duplicate a statement': (r, cp) => {
    cp.entries.push(structuredClone(cp.entries[int(0, cp.entries.length - 1)(r)]));
    return cp;
  },
  'change an amount': (r, cp) => {
    const withMoney = cp.entries.filter((e) => typeof e.statement.result?.minor === 'number');
    if (!withMoney.length) return null;
    const e = withMoney[int(0, withMoney.length - 1)(r)];
    e.statement.result.minor = e.statement.result.minor + int(1, 9999)(r);
    return cp;
  },
  'change a reference': (r, cp) => {
    const e = cp.entries[int(0, cp.entries.length - 1)(r)];
    if (typeof e.statement.result?.ref !== 'string') return null;
    e.statement.result.ref = 'FORGED';
    return cp;
  },
  'rename a step': (r, cp) => {
    // Guaranteed to differ. A mutation that can pick the value already there
    // is a mutation that sometimes does nothing, and a "clean verification" on
    // one of those reads as a hole in the verifier rather than a hole in the
    // generator. That happened here before this was written.
    const e = cp.entries[int(0, cp.entries.length - 1)(r)];
    const others = ['execute', 'confirm', 'cancel', 'upgrade', 'none']
      .filter((x) => x !== e.statement.step);
    e.statement.step = others[int(0, others.length - 1)(r)];
    return cp;
  },
  'reassign a statement to another vendor': (r, cp) => {
    const e = cp.entries[int(0, cp.entries.length - 1)(r)];
    const others = ['fly', 'stay', 'visa', 'nobody'].filter((x) => x !== e.statement.vendor);
    e.statement.vendor = others[int(0, others.length - 1)(r)];
    return cp;
  },
  'point a statement at another origin': (r, cp) => {
    const e = cp.entries[int(0, cp.entries.length - 1)(r)];
    const others = ['https://fly.example', 'https://stay.example', 'https://evil.example', '']
      .filter((x) => x !== e.statement.origin);
    e.statement.origin = others[int(0, others.length - 1)(r)];
    return cp;
  },
  'move a statement into another commitment': (r, cp) => {
    cp.entries[int(0, cp.entries.length - 1)(r)].statement.sagaId = `saga_other_${int(1, 99)(r)}`;
    return cp;
  },
  'change the plan a statement attests to': (r, cp) => {
    const e = cp.entries[int(0, cp.entries.length - 1)(r)];
    e.statement.plan = { ...e.statement.plan, steps: (e.statement.plan.steps ?? []).slice(1) };
    return cp;
  },
  'swap two signatures': (r, cp) => {
    if (cp.entries.length < 2) return null;
    const [a, b] = [cp.entries[0], cp.entries[1]];
    [a.signature, b.signature] = [b.signature, a.signature];
    return cp;
  },
  'corrupt a signature': (r, cp) => {
    const e = cp.entries[int(0, cp.entries.length - 1)(r)];
    const s = e.signature;
    e.signature = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    return cp;
  },
  'claim a different outcome': (r, cp) => {
    const others = ['committed', 'unwound', 'in-doubt', 'refused', 'Committed', 'done', null]
      .filter((x) => x !== base.receipt.outcome);
    cp.outcome = others[int(0, others.length - 1)(r)];
    return cp;
  },
  'restate the root': (r, cp) => {
    cp.root = cp.root.slice(0, -1) + (cp.root.endsWith('0') ? '1' : '0');
    return cp;
  },
  'move a proof to another entry': (r, cp) => {
    if (cp.proofs.length < 2) return null;
    cp.proofs.reverse();
    return cp;
  },
  'claim a key the origin does not publish': (r, cp) => {
    cp.entries[int(0, cp.entries.length - 1)(r)].keyId = 'a-key-nobody-has';
    return cp;
  },
  'backdate a statement before its key existed': (r, cp) => {
    cp.entries[int(0, cp.entries.length - 1)(r)].statement.at = '1999-01-01T00:00:00.000Z';
    return cp;
  },
};

/** Mutations that change nothing a verifier reads. None may be rejected. */
const HARMLESS = {
  'add an unread top-level field': (r, cp) => { cp.decoration = int(0, 99)(r); return cp; },
  'change when the receipt was issued': (r, cp) => { cp.at = '2030-01-01T00:00:00.000Z'; return cp; },
  'reorder the statements': (r, cp) => {
    // Classified as meaningful at first, and that was wrong: a receipt is a
    // set of statements, not a sequence. Reordering and rebuilding the tree
    // yields a different root over exactly the same facts, every statement
    // carries the same plan, and the order of events is recoverable from the
    // timestamps inside them. A verifier that rejected this would reject a
    // receipt somebody had merely re-serialised.
    if (cp.entries.length < 2) return null;
    cp.entries.reverse();
    return cp;
  },
  'rewrite the vendors map': (r, cp) => {
    // Deliberately unread: keys are resolved from the origin inside each
    // signed statement, never from this map, which the coordinator writes.
    cp.vendors = { fly: { origin: 'https://evil.example', keyId: 'nope' } };
    return cp;
  },
};

const mutate = async (name, table, r) => {
  const copy = structuredClone(base.receipt);
  const out = table[name](r, copy);
  if (!out) return null;
  // A coordinator rebuilds the tree around whatever it left, because a root
  // that no longer matches is caught by the first check and proves nothing
  // about the rest.
  return name === 'restate the root' || name === 'move a proof to another entry'
    ? out : rebuild(out, out.entries, out.outcome);
};

test('an honest receipt verifies, so the fuzzer is measuring the verifier', async () => {
  const v = await verifyReceipt(base.receipt, base.resolve);
  assert.equal(v.ok, true, v.complaints.join('; '));
});

test('every mutation that changes what a receipt means is rejected', async () => {
  const names = Object.keys(MEANINGFUL);
  const seen = new Set();
  await forAll(record({ which: int(0, names.length - 1), n: int(1, 999999) }),
    async ({ which, n }) => {
      // Total, because the shrinker can hand back inputs the generator would
      // never produce -- it drops object keys, so `which` arrives undefined on
      // the way to a minimal counterexample. A property that throws on those
      // reports its own arithmetic rather than the defect it found.
      const name = names[Math.abs(Number(which) || 0) % names.length];
      // Seeded from the case, not Math.random: a fuzzer whose failures cannot
      // be replayed is a fuzzer whose failures get closed as flakes.
      const forged = await mutate(name, MEANINGFUL, rng(Number(n) || 1));
      if (!forged) return true;
      seen.add(name);
      const v = await verifyReceipt(await forged, base.resolve);
      return v.ok === false || `"${name}" produced a receipt that verified clean`;
    }, { runs: 340 });

  assert.equal(seen.size, names.length,
    `only ${seen.size} of ${names.length} mutations were reached: `
    + names.filter((n) => !seen.has(n)).join(', '));
});

test('a mutation that changes nothing a verifier reads is not rejected', async () => {
  // The other half of the boundary. A verifier that fails everything is as
  // useless as one that passes everything, and only the first looks safe.
  for (const name of Object.keys(HARMLESS)) {
    const changed = await mutate(name, HARMLESS, rng(7));
    if (!changed) continue;
    const v = await verifyReceipt(await changed, base.resolve);
    assert.equal(v.ok, true, `"${name}" was rejected: ${v.complaints.join('; ')}`);
  }
});
