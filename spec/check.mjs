#!/usr/bin/env node
// An explicit-state model checker, in about a hundred lines.
//
// Breadth-first over every state the machine in model.mjs can reach, from every
// plan shape up to N participants, checking every invariant in every state. BFS
// rather than DFS for one reason: when an invariant fails, the trace that
// reaches it is the shortest one that does, and a four-step counterexample is
// something a person can read.
//
//   node spec/check.mjs          three participants
//   SIZE=4 node spec/check.mjs   four, which is slower and finds nothing new
//
// The state count it prints is the whole reachable space, not a sample of it.

import { initial, ACTIONS, INVARIANTS, RUNGS } from './model.mjs';

/** Every plan of exactly n participants: each one of each rung. */
function* plans(n) {
  if (n === 0) { yield []; return; }
  for (const rest of plans(n - 1)) {
    for (const rung of RUNGS) yield [...rest, { v: `v${rest.length}`, rung }];
  }
}

/**
 * A state's identity, for the visited set.
 *
 * The plan is part of it: the same booleans under a different plan shape are a
 * different state, and collapsing them would silently stop exploring.
 */
const idOf = (s) => JSON.stringify([
  s.plan.map((p) => p.rung), s.proposed, s.committable, s.explained, s.accepted,
  s.spent, s.phase, [...s.journalled].sort(), [...s.performed].sort(),
  [...s.reversed].sort(), s.outcome,
]);

/**
 * Every reachable state, over every plan of up to `size` participants.
 *
 * Exported because the tests that tie this model to the implementation need
 * exactly the same set of states the invariants were proved over -- a second
 * copy of this walk that drifted would quietly prove something else.
 */
export function* reachable({ size = 3 } = {}) {
  for (let n = 1; n <= size; n++) {
    for (const plan of plans(n)) {
      const start = initial(plan);
      const seen = new Set([idOf(start)]);
      const queue = [start];
      while (queue.length) {
        const s = queue.shift();
        yield s;
        for (const action of ACTIONS) {
          if (!action.guard(s)) continue;
          for (const next of action.effects(s)) {
            const id = idOf(next);
            if (seen.has(id)) continue;
            seen.add(id);
            queue.push(next);
          }
        }
      }
    }
  }
}

export function check({ size = 3 } = {}) {
  let states = 0, transitions = 0;
  const broken = [];

  for (let n = 1; n <= size; n++) {
    for (const plan of plans(n)) {
      const start = initial(plan);
      const seen = new Map([[idOf(start), null]]);   // id -> [previousId, actionName]
      const queue = [start];

      while (queue.length) {
        const s = queue.shift();
        states++;

        for (const inv of INVARIANTS) {
          if (inv.holds(s)) continue;
          // Walk the parent chain back to the initial state.
          const trace = [];
          for (let id = idOf(s); seen.get(id); id = seen.get(id)[0]) trace.unshift(seen.get(id)[1]);
          broken.push({ invariant: inv.name, doc: inv.doc, trace, state: s });
          break;
        }

        for (const action of ACTIONS) {
          if (!action.guard(s)) continue;
          for (const next of action.effects(s)) {
            transitions++;
            const id = idOf(next);
            if (seen.has(id)) continue;
            seen.set(id, [idOf(s), action.name]);
            queue.push(next);
          }
        }
      }
    }
  }
  return { states, transitions, broken, invariants: INVARIANTS.length, size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const size = Number(process.env.SIZE ?? 3);
  const t = Date.now();
  const out = check({ size });

  console.log(`  ${out.states.toLocaleString()} reachable states, `
    + `${out.transitions.toLocaleString()} transitions, `
    + `over every plan of up to ${size} participants`);
  console.log(`  ${out.invariants} invariants, checked in every one of them\n`);

  for (const inv of INVARIANTS) {
    const bad = out.broken.find((b) => b.invariant === inv.name);
    console.log(`  ${bad ? '✗' : '✓'} ${inv.name}`);
    console.log(`      ${inv.doc}`);
    if (bad) console.log(`      counterexample: ${bad.trace.join(' → ') || '(initial state)'}`);
  }

  console.log(out.broken.length
    ? `\nMODEL FAILED — ${out.broken.length}`
    : `\nMODEL HOLDS (${Date.now() - t}ms)`);
  process.exit(out.broken.length ? 1 : 0);
}
