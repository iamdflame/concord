// The model holds, the module matches it, and the model is about this code.
//
// The third one is the point. A formal model that nothing connects to the
// implementation proves a property of a document. The last test here takes
// every state the checker reaches and asks the *shipped* desiredNames() what it
// would register there -- so the invariant proved exhaustively over the model
// is the invariant the running coordinator obeys, and not a parallel claim that
// happens to use the same words.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check, reachable } from './check.mjs';
import { ACTIONS, INVARIANTS, RUNGS, commitRegistered } from './model.mjs';
import { render } from './build.mjs';
import { desiredNames } from '../concord/agent-surface.mjs';

test('every invariant holds in every reachable state', () => {
  const out = check({ size: 3 });

  assert.deepEqual(out.broken, [], out.broken.length
    ? `${out.broken[0].invariant} fails: ${out.broken[0].trace.join(' → ')}`
    : '');
  // Not a sample. If a change collapses the state space, this fails rather
  // than passing faster -- which is the failure mode of every exhaustive check
  // that does not assert its own size.
  assert.ok(out.states > 800, `only ${out.states} states reachable`);
  assert.equal(out.invariants, INVARIANTS.length);
});

test('the model reaches every outcome the protocol defines', () => {
  // An exhaustive check of a machine that never gets anywhere is exhaustive
  // about nothing.
  const outcomes = new Set();
  let withEffects = 0, reversedSomething = 0, irreversibleRan = 0;

  for (const s of reachable({ size: 3 })) {
    outcomes.add(s.outcome ?? 'none');
    if (s.performed.length) withEffects++;
    if (s.reversed.length) reversedSomething++;
    if (s.performed.some((k) => s.plan.some((p) => p.rung === 'irreversible' && `${p.v}.execute` === k))) {
      irreversibleRan++;
    }
  }
  assert.deepEqual([...outcomes].sort(), ['committed', 'none', 'refused', 'unwound']);
  assert.ok(withEffects > 150, `only ${withEffects} states had anything contacted`);
  assert.ok(reversedSomething > 100, `only ${reversedSomething} states unwound anything`);
  assert.ok(irreversibleRan > 50, `only ${irreversibleRan} states ran an irreversible step`);
});

test('the committed TLA+ module is what the generator produces', () => {
  // The same discipline verify/lib is held to. A generated artefact that is not
  // regenerated is a stale artefact, and a stale formal model is worse than
  // none: it reads as a guarantee about code it no longer describes.
  //
  // Compared, never rewritten. The first version of this test ran the
  // generator, so a stale file failed once and then passed for ever after
  // because the test had quietly fixed it -- a check that repairs what it is
  // checking is not a check.
  const { tla, cfg } = render();
  assert.equal(readFileSync(new URL('./Concord.tla', import.meta.url), 'utf8'), tla,
    'spec/Concord.tla is stale — run `node spec/build.mjs` and commit');
  assert.equal(readFileSync(new URL('./Concord.cfg', import.meta.url), 'utf8'), cfg,
    'spec/Concord.cfg is stale — run `node spec/build.mjs` and commit');
});

test('every action and invariant in the model appears in the module', () => {
  const tla = readFileSync(new URL('./Concord.tla', import.meta.url), 'utf8');
  const cfg = readFileSync(new URL('./Concord.cfg', import.meta.url), 'utf8');
  for (const a of ACTIONS) {
    assert.ok(tla.includes(`\n${a.name} ==`) || tla.includes(`\n${a.name}(`),
      `${a.name} is executed by the checker but is not in the module`);
  }
  for (const i of INVARIANTS) {
    assert.ok(tla.includes(`${i.name} ==`), `${i.name} is checked but is not in the module`);
    assert.ok(cfg.includes(`INVARIANT ${i.name}`), `${i.name} is not checked by the TLC config`);
  }
});

test('the model is about this coordinator, not a parallel description of one', () => {
  // The link. Every state the checker proved the invariants over is handed to
  // the *shipped* desiredNames(), which must agree about whether concord_commit
  // is registered there. If someone loosens the real permission model, the
  // formal proof stops applying to it, and this is the thing that says so.
  let compared = 0, registered = 0;

  for (const s of reachable({ size: 3 })) {
    const real = desiredNames({
      proposalId: s.proposed ? 'proposal_x' : null,
      committable: s.committable,
      explained: s.explained,
      accepted: s.accepted,
      committed: s.spent,
    }).includes('concord_commit');

    assert.equal(real, commitRegistered(s),
      `the model and desiredNames() disagree at ${JSON.stringify({
        proposed: s.proposed, committable: s.committable, explained: s.explained,
        accepted: s.accepted, spent: s.spent })}`);
    compared++;
    if (real) registered++;
  }
  assert.ok(compared > 800, `only ${compared} states compared against the real surface`);
  assert.ok(registered > 25,
    `concord_commit was registered in only ${registered} of them — this comparison is vacuous`);
});

test('the model uses the same vocabulary as the ladder', () => {
  // A model whose rungs drifted from the implementation's would prove things
  // about a protocol nobody ships.
  assert.deepEqual([...RUNGS].sort(), ['compensable', 'irreversible', 'reservable']);
});
