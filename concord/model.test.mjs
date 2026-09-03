// A reference model, and randomised command sequences run against both.
//
// Everything else in this suite checks that the implementation upholds a
// property. This checks something stronger and different in kind: that it
// agrees, after every step of an arbitrary sequence, with an independent model
// of what it was supposed to do.
//
// The distinction is in how the model is derived. It never reads AgentSurface's
// bookkeeping. It reads a log of what an outside observer saw happen -- which
// proposal came back, which digest an explanation returned, which calls threw
// -- and decides for itself whether a person has accepted something that has
// not yet been spent. Then the two are compared. A bug that corrupts the
// implementation's private booleans is invisible to a property written over
// those same booleans, and is caught here.
//
// What that buys is the one sentence this whole project rests on:
//
//   concord_commit is registered if and only if a person has accepted the
//   exact guarantee that was explained to them, on the proposal the surface is
//   currently shaped around, and that acceptance has not been spent.
//
// A machine-checked invariant over every sequence generated below, rather than
// a sentence in a README.
//
// ── on vacuity ──────────────────────────────────────────────────────────────
//
// A property test that never reaches the interesting state passes for the
// wrong reason, and passes loudly. The first draft of this file did exactly
// that: concord_commit was registered in 1% of the steps it checked, and the
// unwind-ordering property was vacuous in 95% of its runs, because a uniform
// generator almost never produces propose-explain-accept in that order with
// nothing in between. The generators below are weighted, and every property
// ends by asserting how much of the interesting space it actually reached. If
// a later change to the generator quietly stops producing acceptances, these
// fail rather than going green faster.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSurface, desiredNames, FORBIDDEN } from './agent-surface.mjs';
import { runSaga, OUTCOME } from './saga.mjs';
import { plan as buildPlan, RUNG } from './ladder.mjs';
import { forAll, array, pick, int } from '../kit/property.mjs';

const ws = (steps) => ({ ...steps, status: { tool: 'lookup' } });
const PARTICIPANTS = [
  { id: 'fly', title: 'Northwind Air', origin: 'https://fly.example',
    protocol: { steps: ws({ reserve: { tool: 'hold' }, confirm: { tool: 'ticket' }, cancel: { tool: 'release' } }) } },
  { id: 'rail', title: 'Caledonian Rail', origin: 'https://rail.example',
    protocol: { steps: ws({ reserve: { tool: 'hold' }, confirm: { tool: 'ticket' }, cancel: { tool: 'release' } }) } },
  { id: 'stay', title: 'Rowan House', origin: 'https://stay.example',
    protocol: { steps: ws({ execute: { tool: 'book' }, compensate: { tool: 'refund' } }) } },
  { id: 'room', title: 'Sable Rooms', origin: 'https://room.example',
    protocol: { steps: ws({ execute: { tool: 'book' }, compensate: { tool: 'refund' } }) } },
  { id: 'visa', title: 'Consular Fee', origin: 'https://visa.example',
    protocol: { steps: ws({ execute: { tool: 'charge' } }) } },
  // A second irreversible participant, so "two of these and the answer is no"
  // is reachable by the generator rather than only by a hand-written case.
  { id: 'permit', title: 'Entry Permit', origin: 'https://permit.example',
    protocol: { steps: ws({ execute: { tool: 'pay' } }) } },
];

/** pick(), but some outcomes are worth more runs than others. */
const weighted = (...pairs) => (r) => {
  const total = pairs.reduce((t, [, w]) => t + w, 0);
  let x = r() * total;
  for (const [value, w] of pairs) if ((x -= w) < 0) return value;
  return pairs.at(-1)[0];
};

const VENDOR_SETS = [
  ['fly'], ['stay'], ['visa'],
  ['fly', 'stay'], ['fly', 'visa'], ['stay', 'visa'], ['fly', 'stay', 'visa'],
  ['visa', 'permit'], ['fly', 'visa', 'permit'],   // two irreversibles: refusable
];

// ────────────────────────────────────────────────────────────────────────────
// The model
// ────────────────────────────────────────────────────────────────────────────

/**
 * Is there, right now, an acceptance that has not been spent?
 *
 * Derived only from what was observed. `log` holds one entry per thing that
 * visibly happened, in order, and nothing else -- no access to the surface.
 *
 * The rules, stated the way a person would state them:
 *
 *   - the surface is shaped around the proposal most recently proposed, and
 *     asking a new question throws away the answer to the last one;
 *   - an acceptance counts only if it carried the digest of the explanation
 *     actually given for that same proposal;
 *   - committing spends it.
 */
function acceptanceStands(log) {
  let current = null;      // the proposal the surface is shaped around
  let explained = null;    // the digest the last explanation of it returned
  let accepted = false;
  let spent = false;

  for (const e of log) {
    if (e.t === 'proposed') {
      current = e; explained = null; accepted = false; spent = false;
    } else if (e.id !== current?.id) {
      continue;            // anything aimed at a stale proposal changes nothing here
    } else if (e.t === 'explained') {
      explained = e.digest;
    } else if (e.t === 'accepted') {
      // The digest is the whole point: accepting something other than what was
      // explained is not accepting it.
      if (explained !== null && e.digest === explained) accepted = true;
    } else if (e.t === 'committed') {
      spent = true;
    }
  }
  return Boolean(current && current.committable && accepted && !spent);
}

/** The tool names the model expects, given the same log. */
function expectedTools(log) {
  const names = ['concord_get_surface', 'concord_inspect_vendor',
                 'concord_list_vendors', 'concord_propose_commitment'];
  if (log.some((e) => e.t === 'proposed')) names.push('concord_explain_guarantee');
  if (acceptanceStands(log)) names.push('concord_commit');
  return names.sort();
}

// ────────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────────

const command = (r) => ({
  kind: weighted(['propose', 1], ['explain', 4], ['accept', 5], ['commit', 2], ['inspect', 1])(r),
  vendors: pick(...VENDOR_SETS)(r),
  stale: r() < 0.15,          // aim at an earlier proposal instead of the current one
  digest: weighted(['right', 5], ['stale', 1], ['wrong', 1], ['omitted', 1])(r),
});

const surface = () => {
  const bind = () => {
    const call = async () => ({ ref: 'ok' });
    call.attestations = []; call.vendors = {};
    return call;
  };
  return new AgentSurface({ participants: PARTICIPANTS, bind });
};

test('the registered surface always agrees with an independent model of it', async () => {
  const reached = { steps: 0, committable: 0, sequences: 0, commits: 0, refusals: 0 };

  await forAll(array(command, { min: 2, max: 18 }), async (commands) => {
    const s = surface();
    const log = [];
    const seen = [];             // every proposal id ever returned, oldest first
    const digests = new Map();   // proposalId -> the digest its explanation returned
    let lastDigest = null;       // a digest from some earlier explanation, for "stale"
    let sawTool = false;

    const check = (after) => {
      const actual = [...desiredNames(s.state())].sort();
      assert.deepEqual(actual, expectedTools(log),
        `after ${after}, the surface and the model disagree about what is registered`);
      // Restated separately because it is the claim, and a deepEqual that
      // drifts should not be able to take this with it.
      assert.equal(actual.includes('concord_commit'), acceptanceStands(log),
        `after ${after}, concord_commit is `
        + `${actual.includes('concord_commit') ? 'present' : 'absent'} and the model says otherwise`);
      for (const word of FORBIDDEN) {
        assert.ok(!actual.some((n) => n.includes(word)),
          `after ${after}, a tool named for granting permission appeared: ${actual}`);
      }
      reached.steps++;
      if (actual.includes('concord_commit')) { reached.committable++; sawTool = true; }
    };

    check('nothing');

    for (const c of commands) {
      const id = c.stale && seen.length > 1 ? seen[0] : seen.at(-1);
      try {
        if (c.kind === 'propose') {
          const out = s.propose({ intent: 'go', vendors: c.vendors });
          seen.push(out.proposalId);
          if (!out.committable) reached.refusals++;
          log.push({ t: 'proposed', id: out.proposalId, committable: out.committable });
        } else if (c.kind === 'explain' && id) {
          const out = await s.explain({ proposalId: id });
          digests.set(id, out.explanationDigest);
          lastDigest = out.explanationDigest;
          log.push({ t: 'explained', id, digest: out.explanationDigest });
        } else if (c.kind === 'accept' && id) {
          const d = { right: digests.get(id), stale: lastDigest,
                      wrong: 'not-a-digest', omitted: undefined }[c.digest];
          s.accept({ proposalId: id, digest: d });
          log.push({ t: 'accepted', id, digest: d });
        } else if (c.kind === 'commit' && id) {
          const d = c.digest === 'omitted' ? undefined
            : { right: digests.get(id), stale: lastDigest, wrong: 'not-a-digest' }[c.digest];
          await s.commit({ proposalId: id, digest: d });
          reached.commits++;
          log.push({ t: 'committed', id });
        } else if (c.kind === 'inspect') {
          s.listVendors();
        }
      } catch (err) {
        // A refusal is a legitimate outcome of a command, and the model already
        // says so by not recording anything. A TypeError is not.
        if (err.name !== 'Refused') throw err;
      }
      check(`${c.kind}(${c.digest})`);
    }
    if (sawTool) reached.sequences++;
  }, { runs: 250 });

  // The property is only worth its runtime if it got to the states it is about.
  assert.ok(reached.steps > 2000, `only ${reached.steps} states checked`);
  assert.ok(reached.committable > 60,
    `concord_commit was registered in only ${reached.committable} of ${reached.steps} states — `
    + 'the generator has stopped producing acceptances and this property is now vacuous');
  assert.ok(reached.sequences > 25, `only ${reached.sequences} sequences ever reached an acceptance`);
  assert.ok(reached.commits > 8, `only ${reached.commits} acceptances were actually spent`);
  assert.ok(reached.refusals > 15, `only ${reached.refusals} refused plans were proposed`);
});

test('no sequence of agent calls ever registers concord_commit', async () => {
  // The same generator with the one command a person makes removed. An agent
  // has every other door; none of them may open this one. If a sequence exists
  // that gets the commit tool onto the surface without accept(), it is here.
  const agentOnly = (r) => {
    const c = command(r);
    return { ...c, kind: c.kind === 'accept' ? 'explain' : c.kind };
  };

  let steps = 0;
  await forAll(array(agentOnly, { min: 2, max: 20 }), async (commands) => {
    const s = surface();
    const seen = [];
    for (const c of commands) {
      try {
        if (c.kind === 'propose') seen.push(s.propose({ intent: 'go', vendors: c.vendors }).proposalId);
        else if (c.kind === 'explain' && seen.length) await s.explain({ proposalId: seen.at(-1) });
        else if (c.kind === 'commit' && seen.length) await s.commit({ proposalId: seen.at(-1) });
      } catch (err) { if (err.name !== 'Refused') throw err; }
      steps++;
      if (desiredNames(s.state()).includes('concord_commit')) {
        return 'an agent reached concord_commit without a person accepting anything';
      }
    }
  }, { runs: 250 });
  assert.ok(steps > 2000, `only ${steps} agent states explored`);
});

// ────────────────────────────────────────────────────────────────────────────
// The executor, against the same treatment
// ────────────────────────────────────────────────────────────────────────────

// Two reservables and two compensables in most sets, because "unwinding
// reverses the order" is a claim about a list with more than one thing in it.
// The first draft had one of each, so reversing and not reversing produced the
// same journal and the property could not fail. Mutation testing found that;
// nothing else would have.
const SAGA_SETS = [
  ['fly', 'rail', 'stay', 'room'], ['fly', 'rail', 'stay', 'room', 'visa'],
  ['fly', 'rail', 'stay'], ['stay', 'room', 'visa'], ['fly', 'rail', 'visa'],
  ['fly', 'rail', 'stay', 'room'], ['fly', 'stay'],
  ['visa', 'permit'],                       // refused; runSaga must say so and touch nothing
];

const schedule = (r) => ({
  vendors: pick(...SAGA_SETS)(r),
  nth: int(0, 20)(r),
  // -1 for most runs: a reversal that fails is the interesting minority, not
  // the norm, and an unwind that always breaks never exercises a clean one.
  breakReversal: r() < 0.35 ? int(0, 3)(r) : -1,
});

/**
 * A vendor set whose Nth effectful call fails, and whose Rth reversal fails.
 *
 * The second knob was missing from the first version of this file, and its
 * absence made two mutations of the executor undetectable: with every
 * compensate and cancel guaranteed to succeed, `failures` was always empty, so
 * an unwind could only ever conclude UNWOUND and forcing that constant changed
 * nothing. A vendor that will not give the money back is the case the whole
 * IN DOUBT outcome exists for, and it has to be generated to be tested.
 */
function world(failAt, breakReversalAt) {
  let n = 0, r = 0;
  const call = async (id, tool, args, { step }) => {
    if (['reserve', 'execute', 'confirm'].includes(step) && n++ === failAt) {
      throw new Error(`${id} declined ${step}`);
    }
    if (['compensate', 'cancel'].includes(step) && r++ === breakReversalAt) {
      throw new Error(`${id} will not ${step}`);
    }
    return { ref: `${id}-ref` };
  };
  call.attestations = []; call.vendors = {};
  return call;
}

/**
 * Run one schedule. `nth` is folded into the number of calls the plan actually
 * makes, because a fault index past the end of the run is a run with no fault
 * in it, and a generator that mostly produces those is a generator that mostly
 * proves nothing.
 */
async function runSchedule({ vendors, nth, breakReversal }) {
  const chosen = PARTICIPANTS.filter((p) => vendors.includes(p.id)).map((p) => ({ ...p, input: {} }));
  const planned = buildPlan(chosen);
  const rung = new Map(planned.rungs.map((x) => [x.id, x.rung]));
  const reservable = [...rung.values()].filter((v) => v === RUNG.RESERVABLE).length;
  // reserve + (execute | irreversible) + confirm
  const calls = reservable + (planned.order.length - reservable) + reservable;
  const failAt = calls ? 1 + (nth % calls) : 0;

  const out = await runSaga({
    plan: planned, participants: chosen, call: world(failAt, breakReversal),
    confirmRetries: 1, retryDelayMs: 0, sagaId: 'saga_model',
  });
  return { out, planned, rung };
}

test('unwinding always visits exactly the reverse of what was done', async () => {
  // Not "roughly the reverse". A saga that reverses in the order things were
  // done releases a hold a later step depended on; one that skips an entry
  // leaves a real effect standing. Both are the same bug from different ends.
  const seen = { runs: 0, unwound: 0 };

  await forAll(schedule, async (s) => {
    const { out, rung } = await runSchedule(s);
    seen.runs++;
    if (out.outcome === OUTCOME.REFUSED) return;

    const j = out.journal;
    // What really happened, in order, restricted to what can be taken back.
    const did = j.filter((e) => ['reserved', 'executed'].includes(e.type))
      .map((e) => e.id).filter((id) => rung.get(id) !== RUNG.IRREVERSIBLE);
    // What the unwind visited. `stands` is included: a hold already confirmed
    // is visited and deliberately not cancelled, and leaving it out would let a
    // genuinely skipped entry hide behind it.
    const visited = j.filter((e) => ['compensate', 'cancel', 'stands'].includes(e.type))
      .map((e) => e.id);

    if (!visited.length) return;      // nothing unwound; the ordering claim is vacuous here
    seen.unwound++;
    const expected = [...did].reverse();
    if (JSON.stringify(visited) !== JSON.stringify(expected)) {
      return `unwound ${JSON.stringify(visited)} but did ${JSON.stringify(did)}`;
    }
  }, { runs: 150 });

  assert.ok(seen.unwound > 30,
    `only ${seen.unwound} of ${seen.runs} runs unwound anything — this property is vacuous`);
});

test('every outcome implies the facts that outcome claims about the world', async () => {
  // The replacement for a property that could not fail. The first version
  // asserted that an irreversible success is never reported as UNWOUND -- true,
  // but unreachable, because past the point of no return the saga does not
  // unwind at all. Forcing the outcome to UNWOUND everywhere did not break it.
  //
  // These are four implications instead, each read off the journal -- what the
  // vendors were actually asked and what they actually answered -- and each one
  // false under some mutation of the executor.
  const seen = { outcomes: new Set(), checked: 0 };

  await forAll(schedule, async (s) => {
    const { out, planned, rung } = await runSchedule(s);
    const j = out.journal;
    seen.outcomes.add(out.outcome);
    seen.checked++;

    const ids = (...types) => j.filter((e) => types.includes(e.type)).map((e) => e.id);
    const succeeded = new Set(ids('reserved', 'executed', 'committed'));
    const reversalTried = new Set(ids('compensate', 'cancel'));
    const reversalFailed = new Set(ids('compensate_failed', 'cancel_failed'));
    const stands = new Set(ids('stands'));
    const confirmed = new Set(ids('confirmed'));

    if (out.outcome === OUTCOME.REFUSED) {
      if (succeeded.size) return `refused, but ${[...succeeded]} were contacted anyway`;
      return;
    }
    if (out.outcome === OUTCOME.COMMITTED) {
      // Everything planned went through, and nothing was taken back.
      const missing = planned.order.filter((id) => !succeeded.has(id));
      if (missing.length) return `committed, but ${missing} never succeeded`;
      if (reversalTried.size) return `committed, but ${[...reversalTried]} were reversed`;
      const unconfirmed = planned.order
        .filter((id) => rung.get(id) === RUNG.RESERVABLE && !confirmed.has(id));
      if (unconfirmed.length) return `committed, but the holds on ${unconfirmed} were never confirmed`;
      return;
    }
    if (out.outcome === OUTCOME.UNWOUND) {
      // "This did not happen." Every reversible effect must have been reversed,
      // no reversal may have failed, nothing may still stand, and nothing
      // irreversible may have run at all.
      if (j.some((e) => e.type === 'committed')) return 'unwound, but an irreversible step ran';
      if (reversalFailed.size) return `unwound, but reversing ${[...reversalFailed]} failed`;
      if (stands.size) return `unwound, but ${[...stands]} still stands`;
      const notReversed = [...succeeded].filter((id) => !reversalTried.has(id));
      if (notReversed.length) return `unwound, but ${notReversed} were never reversed`;
      return;
    }
    if (out.outcome === OUTCOME.IN_DOUBT) {
      // The honest answer, and it has to be earned: something really is
      // outstanding. Reporting IN DOUBT when everything was cleanly reversed
      // would be its own kind of lie.
      const outstanding = reversalFailed.size || stands.size
        || j.some((e) => e.type === 'in_doubt') || j.some((e) => e.type === 'journal_failed');
      if (!outstanding) return 'reported in doubt with nothing actually outstanding';
      return;
    }
    return `unknown outcome ${out.outcome}`;
  }, { runs: 200 });

  assert.deepEqual([...seen.outcomes].sort(),
    ['committed', 'in-doubt', 'refused', 'unwound'],
    'the schedules no longer reach every outcome the protocol defines');
});
