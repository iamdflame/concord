// Properties, checked over generated inputs rather than chosen ones.
//
// The example tests elsewhere pin behaviour a person thought of. These state
// what must be true of *every* input, and let the machine look for the case
// nobody thought of. Each one below is a sentence from SPEC.md turned into
// something that can fail.
//
//   SEED=123 node --test concord/properties.test.mjs   replay a failure

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forAll, array, pick, int, record, json, bool } from '../kit/property.mjs';
import { plan, classify, GUARANTEE, RUNG, expectedSteps } from './ladder.mjs';
import { canonical } from '../kit/canonical.mjs';
import { buildTree, proofFor, verifyInclusion, leafHash, deriveOutcome } from './receipt.mjs';

// ── the ladder ─────────────────────────────────────────────────────────────

/** A participant with an arbitrary, possibly nonsensical, set of steps. */
const participant = (n) => (r) => {
  const phases = ['reserve', 'confirm', 'cancel', 'execute', 'compensate', 'status'];
  const steps = {};
  for (const phase of phases) if (r() < 0.5) steps[phase] = { tool: `${phase}_${n}` };
  return { id: `v${n}`, title: `Vendor ${n}`, origin: `https://v${n}.example`, protocol: { steps } };
};

/**
 * A set of participants, some of which declare that they depend on another.
 *
 * The dependencies matter. Without them the ladder's ordering pass always puts
 * the irreversible participant last on its own, so the guard that refuses a
 * plan where something must *follow* an irreversible step is unreachable --
 * and a mutation removing that guard passed every generated case. A generator
 * that cannot reach a branch is a test that does not cover it, however many
 * cases it runs.
 */
const participants = (r) => {
  const n = int(1, 5)(r);
  const set = Array.from({ length: n }, (_, i) => participant(i)(r));
  for (const p of set) {
    if (r() < 0.35) {
      const other = set[Math.floor(r() * set.length)];
      if (other && other.id !== p.id) p.dependsOn = [other.id];
    }
  }
  return set;
};

test('a guarantee is only ever offered over a plan that can keep it', async () => {
  // SPEC §5. The three things that make a guarantee honest, over any set of
  // participants at all -- including sets whose declarations are incoherent.
  const out = await forAll(participants, (vendors) => {
    const planned = plan(vendors);
    if (planned.guarantee === GUARANTEE.REFUSED) return true;

    const rungs = planned.rungs;
    const irreversible = rungs.filter((x) => x.rung === RUNG.IRREVERSIBLE);
    if (irreversible.length > 1) return 'two irreversible steps were promised as one commitment';

    if (irreversible.length === 1) {
      const last = planned.order.at(-1);
      if (irreversible[0].id !== last) return `${irreversible[0].id} cannot be undone and is not last`;
      if (planned.order[planned.pointOfNoReturn] !== last) {
        return 'the point of no return is not the last step';
      }
    } else if (planned.pointOfNoReturn !== null) {
      return 'a point of no return was named where nothing is irreversible';
    }

    // Everything reversible settles before anything irreversible is touched.
    const rungOf = new Map(rungs.map((x) => [x.id, x.rung]));
    const firstIrreversible = planned.order.findIndex((id) => rungOf.get(id) === RUNG.IRREVERSIBLE);
    if (firstIrreversible >= 0) {
      const after = planned.order.slice(firstIrreversible + 1);
      if (after.length) return `${after.join(', ')} would run after the point of no return`;
    }
    return true;
  }, { runs: 400 });
  assert.ok(out.runs === 400);
});

test('every participant in a plan is classified, and the order holds all of them', async () => {
  await forAll(participants, (vendors) => {
    const planned = plan(vendors);
    if (planned.order.length !== vendors.length) return 'the order lost or invented a participant';
    if (new Set(planned.order).size !== planned.order.length) return 'a participant appears twice';
    if (planned.guarantee === GUARANTEE.REFUSED) return true;
    for (const v of vendors) {
      if (!planned.rungs.some((x) => x.id === v.id)) return `${v.id} was planned over but not classified`;
    }
    return true;
  }, { runs: 300 });
});

test('a participant that declares nothing usable makes the plan refuse', async () => {
  // The one-way property: an unusable participant anywhere means refusal, and
  // never a guarantee computed over the rest.
  await forAll(participants, (vendors) => {
    const unusable = vendors.filter((v) => classify(v).rung === null);
    if (!unusable.length) return true;
    return plan(vendors).guarantee === GUARANTEE.REFUSED
      || `${unusable.map((v) => v.id).join(', ')} declares no protocol and a guarantee was still offered`;
  }, { runs: 300 });
});

test('expectedSteps names two steps for a reservation and one for anything else', async () => {
  await forAll(participants, (vendors) => {
    const planned = plan(vendors);
    if (planned.guarantee === GUARANTEE.REFUSED) return true;
    const steps = expectedSteps(planned.rungs);
    const wanted = planned.rungs.reduce((n, x) => n + (x.rung === RUNG.RESERVABLE ? 2 : 1), 0);
    return steps.length === wanted || `${steps.length} steps for ${planned.rungs.length} participants`;
  }, { runs: 300 });
});

// ── canonicalisation ───────────────────────────────────────────────────────

test('canonical form survives a JSON round trip, for any JSON value', async () => {
  // SPEC §2. If this is not true, a statement signed here and verified in
  // another process disagrees about its own bytes.
  await forAll(json(), (value) => {
    const a = canonical(value);
    const b = canonical(JSON.parse(JSON.stringify(value)));
    return a === b || `${a} became ${b}`;
  }, { runs: 400 });
});

test('canonical form does not depend on the order keys were written in', async () => {
  await forAll(json(2), (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
    const keys = Object.keys(value);
    if (keys.length < 2) return true;
    const shuffled = {};
    for (const k of [...keys].reverse()) shuffled[k] = value[k];
    return canonical(value) === canonical(shuffled) || 'key order changed the bytes';
  }, { runs: 400 });
});

test('canonical form is idempotent', async () => {
  await forAll(json(), (value) => {
    const once = canonical(value);
    return canonical(JSON.parse(once)) === once || 'canonicalising twice changed it';
  }, { runs: 300 });
});

// ── the Merkle tree ────────────────────────────────────────────────────────

const leafSet = (r) => {
  const n = int(1, 12)(r);
  return Array.from({ length: n }, (_, i) => `leaf-${i}-${int(0, 999)(r)}`);
};

test('every leaf of every tree proves its own inclusion, and only its own', async () => {
  // SPEC §12. Checked at every size rather than at the sizes somebody listed.
  await forAll(leafSet, async (raw) => {
    const leaves = await Promise.all(raw.map((x) => leafHash({ x })));
    const { root } = await buildTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const proof = await proofFor(leaves, i);
      if (!await verifyInclusion(leaves[i], proof, root)) return `leaf ${i} of ${leaves.length} failed`;
      // A proof must not carry a different leaf, unless the leaves collide.
      for (let j = 0; j < leaves.length; j++) {
        if (j === i || leaves[j] === leaves[i]) continue;
        if (await verifyInclusion(leaves[j], proof, root)) return `leaf ${j} rode in on leaf ${i}'s proof`;
      }
    }
    return true;
  }, { runs: 60 });
});

test('no mutation of a proof survives verification', async () => {
  await forAll(record({ raw: leafSet, at: int(0, 30) }), async ({ raw, at }) => {
    const leaves = await Promise.all(raw.map((x) => leafHash({ x })));
    const { root } = await buildTree(leaves);
    const i = at % leaves.length;
    const proof = await proofFor(leaves, i);

    const mutations = [
      { ...proof, index: (i + 1) % Math.max(leaves.length, 2) },
      { ...proof, size: proof.size + 1 },
      { ...proof, size: Math.max(1, proof.size - 1) },
      { ...proof, path: [...proof.path, proof.path[0] ?? 'x'.repeat(64)] },
      { ...proof, path: proof.path.slice(1) },
      { ...proof, path: proof.path.map((h) => `0${h.slice(1)}`) },
    ];
    for (const m of mutations) {
      // Changing the index of a one-leaf tree is a no-op; skip the vacuous ones.
      if (JSON.stringify(m) === JSON.stringify(proof)) continue;
      if (await verifyInclusion(leaves[i], m, root)) {
        return `a mutated proof verified: ${JSON.stringify(m).slice(0, 90)}`;
      }
    }
    return true;
  }, { runs: 60 });
});

// ── the derived outcome ────────────────────────────────────────────────────

test('a receipt that accounts for every planned step derives as committed', async () => {
  await forAll(participants, (vendors) => {
    const planned = plan(vendors);
    if (planned.guarantee === GUARANTEE.REFUSED) return true;
    const steps = expectedSteps(planned.rungs);
    const entries = steps.map((s) => {
      const [vendor, step] = s.split('.');
      return { statement: { vendor, step } };
    });
    const derived = deriveOutcome({ parties: planned.order, steps }, entries);
    return derived === 'committed' || `a complete set of statements derived as "${derived}"`;
  }, { runs: 300 });
});

test('dropping any one statement stops a receipt deriving as committed', async () => {
  // The property behind attacks/: whatever is removed, and whatever the
  // coordinator then claims, the evidence no longer says everything happened.
  await forAll(record({ vendors: participants, drop: int(0, 40) }), ({ vendors, drop }) => {
    const planned = plan(vendors);
    if (planned.guarantee === GUARANTEE.REFUSED) return true;
    const steps = expectedSteps(planned.rungs);
    if (steps.length < 2) return true;
    const entries = steps.map((s) => {
      const [vendor, step] = s.split('.');
      return { statement: { vendor, step } };
    });
    const short = entries.filter((_, i) => i !== drop % entries.length);
    const derived = deriveOutcome({ parties: planned.order, steps }, short);
    return derived !== 'committed' || 'a receipt missing a statement still derived as committed';
  }, { runs: 300 });
});
