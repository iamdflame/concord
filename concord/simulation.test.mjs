// Deterministic simulation: break the saga everywhere and check what it says.
//
// The example tests break one vendor at one step, chosen because somebody
// thought of it. This breaks every step in turn, in every way a step can
// break, and asserts the same invariants after each -- so the coverage is the
// cross product rather than the list.
//
// The invariant that matters is the one the whole design exists for:
//
//   nothing is left standing that the coordinator did not tell you about.
//
// A vendor whose reversible effect was not reversed must appear in the
// outcome's failures or stands. Quietly leaving a hold outstanding and
// reporting "unwound" is the specific lie this project was built to prevent,
// and it is the thing asserted after every one of the several hundred runs
// below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSaga, OUTCOME } from './saga.mjs';
import { plan } from './ladder.mjs';
import { Journal, MemoryStore } from './journal.mjs';

const RESERVABLE = { reserve: { tool: 'hold' }, confirm: { tool: 'ticket' },
                     cancel: { tool: 'release' }, status: { tool: 'ask' } };
const COMPENSABLE = { execute: { tool: 'book' }, compensate: { tool: 'refund' },
                      status: { tool: 'ask' } };
const IRREVERSIBLE = { execute: { tool: 'charge' }, status: { tool: 'ask' } };

const SHAPES = { a: RESERVABLE, b: COMPENSABLE, c: IRREVERSIBLE };

const participantsFor = (ids) => ids.map((id) => ({
  id, title: id.toUpperCase(), origin: `https://${id}.example`,
  protocol: { steps: SHAPES[id] }, input: {},
}));

/** Every way a single call can go wrong, and what the coordinator may conclude. */
const FAULTS = ['throws', 'refuses', 'silent', 'fatal', 'reversal-fails'];

/**
 * A vendor set whose Nth effectful call fails in a given way.
 *
 * `happened` records what each vendor really did, independent of what it told
 * the coordinator -- which is the only way to check that the report matches the
 * world. A "silent" fault performs the work and then never answers, which is
 * the case a coordinator cannot distinguish from never having happened and
 * must therefore resolve by asking.
 */
function world({ failAt, fault }) {
  const happened = new Map();   // "id.step" -> did it really occur
  const honoured = new Map();   // idempotency key -> what it returned
  let effectful = 0;

  const call = async (id, tool, args, { step, idempotencyKey }) => {
    if (step === 'status') {
      // Keyed, exactly as a real participant is. Answering about any key this
      // vendor has ever honoured makes a failed cancel look like one that had
      // already succeeded -- invoke() probes on failure, believed the answer,
      // and the saga reported "unwound" over a hold that was still standing.
      // The defect was in this fake; the property it broke was real.
      const key = args?.lookupKey;
      return { happened: honoured.has(key), result: honoured.get(key) ?? null };
    }

    const isForward = step === 'reserve' || step === 'execute';
    const n = isForward ? effectful++ : -1;

    // A reversal-failure schedule needs a forward step to fail first, so that
    // there is something to unwind at all.
    if (isForward && n === failAt && fault === 'reversal-fails') {
      throw new Error(`${id} failed ${step}`);
    }
    if (isForward && n === failAt) {
      // Thrown, not returned. bind() is what turns a vendor's {error} into a
      // rejection, and a simulation that skips bind must honour its contract
      // or it tests a coordinator nobody runs -- this returned the envelope
      // and the saga read a refusal as a successful step.
      if (fault === 'refuses') {
        throw Object.assign(new Error(`${id} declines`), { terminal: true });
      }
      if (fault === 'throws') throw new Error(`${id} threw during ${step}`);
      if (fault === 'fatal') throw Object.assign(new Error('the coordinator stopped'), { fatal: true });
      if (fault === 'silent') {
        // It really happened, and honoured the key; the answer never came
        // back. This is the one case a coordinator cannot tell from "never
        // happened" without asking, which is why the probe exists.
        happened.set(`${id}.${step}`, true);
        honoured.set(idempotencyKey, { ref: `${id}-ref` });
        throw new Error(`${id} never answered ${step}`);
      }
    }

    if (step === 'cancel' || step === 'compensate') {
      // A vendor that declared it could reverse what it does, and will not.
      // The most important failure in this system -- it is what Meridian does
      // on the live deployment -- and the schedule did not contain it, so a
      // mutation that always reported "unwound" passed every run: no run ever
      // produced a failed reversal to contradict it.
      if (fault === 'reversal-fails') {
        throw Object.assign(new Error(`${id} will not ${step}`), { terminal: true });
      }
      happened.set(`${id}.${step === 'cancel' ? 'reserve' : 'execute'}`, false);
      honoured.set(idempotencyKey, { ref: `${id}-ref`, reversed: true });
      return { ref: `${id}-ref`, reversed: true };
    }
    happened.set(`${id}.${step}`, true);
    honoured.set(idempotencyKey, { ref: `${id}-ref` });
    return { ref: `${id}-ref` };
  };

  call.attestations = [];
  call.vendors = {};
  return { call, happened };
}

/** What the coordinator told us is outstanding, in one flat set. */
const reportedOutstanding = (out) => new Set([
  ...(out.failures ?? []).map((f) => f.id ?? f.vendor),
  ...(out.stands ?? []).map((s) => s.id ?? s.vendor ?? s),
  ...(out.committed ?? []).map((c) => c.id),
]);

test('whatever breaks, nothing is left standing that was not reported', async () => {
  const sets = [['a'], ['b'], ['a', 'b'], ['a', 'c'], ['a', 'b', 'c'], ['b', 'c']];
  let runs = 0;

  for (const ids of sets) {
    const participants = participantsFor(ids);
    const planned = plan(participants);
    if (planned.guarantee === 'refused') continue;

    for (let failAt = 0; failAt < ids.length + 1; failAt++) {
      for (const fault of FAULTS) {
        const { call, happened } = world({ failAt, fault });
        const journal = new Journal(new MemoryStore());
        let out;
        try {
          out = await runSaga({
            plan: planned, participants, call, journal,
            confirmRetries: 2, retryDelayMs: 1, retryCapMs: 2,
            callTimeoutMs: 40, sagaTimeoutMs: 4000,
            sagaId: `sim_${ids.join('')}_${failAt}_${fault}`,
          });
        } catch (err) {
          // A fatal fault is a dead coordinator. It unwinds nothing, by
          // design, and recovery is what resolves it -- so there is no report
          // to check and nothing may be claimed.
          assert.ok(fault === 'fatal' || err.fatal,
            `${ids} @${failAt} ${fault}: the saga threw instead of reporting: ${err.message}`);
          runs++;
          continue;
        }

        const where = `${ids.join('+')} @${failAt} ${fault}`;
        assert.ok(Object.values(OUTCOME).includes(out.outcome), `${where}: bad outcome`);

        // The invariant. Anything the world says still stands must be named.
        const standing = [...happened.entries()]
          .filter(([, did]) => did)
          .map(([k]) => k.split('.')[0]);
        const reported = reportedOutstanding(out);

        if (out.outcome === OUTCOME.UNWOUND) {
          assert.deepEqual(standing.filter((id) => !reported.has(id)), [],
            `${where}: reported "unwound" while ${standing} still stands`);
          // And the word means what it says. Naming what is outstanding while
          // labelling the whole thing "unwound" is still telling somebody that
          // nothing stands -- a mutation that always reported UNWOUND passed
          // the check above, because the outstanding vendors were listed in a
          // field nobody would read after being told it was all undone.
          assert.equal(out.failures?.length ?? 0, 0,
            `${where}: "unwound" with failures: ${JSON.stringify(out.failures)}`);
          assert.equal(out.stands?.length ?? 0, 0,
            `${where}: "unwound" with things still standing: ${JSON.stringify(out.stands)}`);
        }
        if (out.outcome === OUTCOME.IN_DOUBT) {
          assert.ok((out.failures?.length ?? 0) + (out.stands?.length ?? 0) > 0,
            `${where}: "in doubt" without naming anything in doubt`);
        }
        if (out.outcome === OUTCOME.COMMITTED) {
          // Everything planned must really have happened.
          for (const step of planned.order) {
            assert.ok(standing.includes(step),
              `${where}: reported "committed" but ${step} never acted`);
          }
        }
        runs++;
      }
    }
  }
  assert.ok(runs > 60, `only ${runs} simulated runs`);
});

test('intent is always journalled before the call it describes', async () => {
  // The property recovery depends on. A result with no intent before it is a
  // step recovery can never find, whatever went wrong.
  for (const fault of FAULTS) {
    for (let failAt = 0; failAt < 3; failAt++) {
      const participants = participantsFor(['a', 'b', 'c']);
      const planned = plan(participants);
      const { call } = world({ failAt, fault });
      const store = new MemoryStore();
      try {
        await runSaga({ plan: planned, participants, call, journal: new Journal(store),
          confirmRetries: 2, retryDelayMs: 1, callTimeoutMs: 40, sagaTimeoutMs: 4000,
          sagaId: `order_${failAt}_${fault}` });
      } catch { /* a dead coordinator still must not have written out of order */ }

      const rows = await store.read();
      const seen = new Set();
      for (const row of rows) {
        if (row.phase === 'intent') seen.add(row.idempotencyKey);
        if (row.phase === 'result' || row.phase === 'failed') {
          assert.ok(seen.has(row.idempotencyKey),
            `${fault} @${failAt}: a ${row.phase} for ${row.idempotencyKey} with no intent before it`);
        }
      }
    }
  }
});

test('an irreversible step is never attempted before every reversal is available', async () => {
  // Phase order, checked from the outside: whatever the fault schedule, the
  // charge is not made until everything that could still be undone has been.
  for (const fault of FAULTS) {
    for (let failAt = 0; failAt < 4; failAt++) {
      const participants = participantsFor(['a', 'b', 'c']);
      const planned = plan(participants);
      const order = [];
      const { call } = world({ failAt, fault });
      const watched = async (id, tool, args, meta) => {
        if (meta.step !== 'status') order.push(`${id}.${meta.step}`);
        return call(id, tool, args, meta);
      };
      watched.attestations = []; watched.vendors = {};

      try {
        await runSaga({ plan: planned, participants, call: watched, journal: null,
          confirmRetries: 2, retryDelayMs: 1, callTimeoutMs: 40, sagaTimeoutMs: 4000,
          sagaId: `phase_${failAt}_${fault}` });
      } catch { /* the ordering claim holds even when it dies */ }

      const charge = order.indexOf('c.execute');
      if (charge < 0) continue;
      const forwardAfter = order.slice(charge + 1)
        .filter((s) => s.endsWith('.reserve') || s.endsWith('.execute'));
      assert.deepEqual(forwardAfter, [],
        `${fault} @${failAt}: ${forwardAfter} was attempted after the point of no return`);
    }
  }
});
