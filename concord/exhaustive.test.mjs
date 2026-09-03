// An exhaustive check of the ladder's safety property.
//
// Not a sample. Every configuration of up to three participants -- each one
// reservable, compensable, irreversible or unusable, under every possible
// pattern of declared dependencies between them -- is enumerated and checked.
// The state count is printed, and it is the whole space rather than a
// confidence interval over it.
//
// This is what would otherwise be a TLA+ model. It is written in the language
// the system is written in, for a reason worth stating: a model in another
// notation is a second artefact that can drift from the code, and checking it
// requires a toolchain nobody running this repository has. This enumerates the
// real plan() over the real classify() and the real ordering pass, so what it
// verifies is the implementation and not a description of it.
//
// The property, from SPEC.md §5:
//
//   if a guarantee is offered at all, then everything reversible is settled
//   before anything irreversible is touched, at most one thing is
//   irreversible, and it is last.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, classify, GUARANTEE, RUNG } from './ladder.mjs';

/** The four things a participant can be, as declarations rather than labels. */
const SHAPES = {
  reservable: { reserve: { tool: 'r' }, confirm: { tool: 'c' }, cancel: { tool: 'x' } },
  compensable: { execute: { tool: 'e' }, compensate: { tool: 'k' } },
  irreversible: { execute: { tool: 'e' } },
  unusable: { reserve: { tool: 'r' } },   // a hold nobody can release
};
const NAMES = Object.keys(SHAPES);

/** Every subset of `xs`, as an array of arrays. */
function subsets(xs) {
  const out = [[]];
  for (const x of xs) for (const s of [...out]) out.push([...s, x]);
  return out;
}

/** Every configuration of exactly n participants: shapes × dependency graphs. */
function* configurations(n) {
  const ids = Array.from({ length: n }, (_, i) => `v${i}`);
  const shapeChoices = [];
  const walk = (i, acc) => {
    if (i === n) { shapeChoices.push([...acc]); return; }
    for (const name of NAMES) { acc.push(name); walk(i + 1, acc); acc.pop(); }
  };
  walk(0, []);

  // Each participant may declare a dependency on any subset of the others,
  // including the cycles that used to throw.
  const depChoices = ids.map((id) => subsets(ids.filter((o) => o !== id)));

  for (const shapes of shapeChoices) {
    const counters = new Array(n).fill(0);
    for (;;) {
      yield ids.map((id, i) => ({
        id, title: id, origin: `https://${id}.example`,
        protocol: { steps: SHAPES[shapes[i]] },
        dependsOn: depChoices[i][counters[i]],
      }));
      let k = n - 1;
      while (k >= 0 && ++counters[k] >= depChoices[k].length) { counters[k] = 0; k--; }
      if (k < 0) break;
    }
  }
}

test('the ladder is safe over every configuration of up to three participants', () => {
  let states = 0;
  let offered = 0;

  for (const n of [1, 2, 3]) {
    for (const participants of configurations(n)) {
      states++;
      const planned = plan(participants);
      const where = () => participants
        .map((p) => `${p.id}:${Object.keys(p.protocol.steps).join('+')}` +
          (p.dependsOn.length ? `->${p.dependsOn}` : '')).join(' ');

      // Whatever the answer, everyone is accounted for exactly once.
      assert.equal(new Set(planned.order).size, participants.length, `order lost one: ${where()}`);

      // An unusable participant anywhere means no guarantee, always.
      const unusable = participants.filter((p) => classify(p).rung === null);
      if (unusable.length) {
        assert.equal(planned.guarantee, GUARANTEE.REFUSED,
          `a guarantee was offered over an unusable participant: ${where()}`);
        continue;
      }
      if (planned.guarantee === GUARANTEE.REFUSED) continue;
      offered++;

      const rungOf = new Map(planned.rungs.map((r) => [r.id, r.rung]));
      const irreversible = planned.order.filter((id) => rungOf.get(id) === RUNG.IRREVERSIBLE);

      assert.ok(irreversible.length <= 1, `two irreversible steps promised as one: ${where()}`);
      if (irreversible.length === 1) {
        assert.equal(planned.order.at(-1), irreversible[0],
          `the irreversible step is not last: ${where()}`);
        assert.equal(planned.order[planned.pointOfNoReturn], irreversible[0],
          `the point of no return is not the irreversible step: ${where()}`);
      } else {
        assert.equal(planned.pointOfNoReturn, null,
          `a point of no return where nothing is irreversible: ${where()}`);
      }

      // Declared dependencies are honoured, or the plan would be committing
      // things in an order their own participants said was impossible.
      for (const p of participants) {
        for (const dep of p.dependsOn) {
          assert.ok(planned.order.indexOf(dep) < planned.order.indexOf(p.id),
            `${p.id} depends on ${dep} and runs before it: ${where()}`);
        }
      }
    }
  }

  // Written down because it is the claim: this is the whole space, not a
  // sample of it. If the model grows, this number changes and somebody has to
  // decide whether the new states are still covered.
  // 4 shapes for one participant; 4x4 shapes x 2x2 dependency choices for two;
  // 4x4x4 shapes x 4x4x4 dependency choices for three.
  assert.equal(states, 4 + (4 * 4) * (2 * 2) + (4 * 4 * 4) * (4 * 4 * 4),
    `enumerated ${states} configurations`);
  console.log(`    ${states} configurations checked exhaustively, `
    + `${offered} of them offered a guarantee`);
  assert.ok(offered > 100, `only ${offered} of ${states} configurations yielded a guarantee`);
});
