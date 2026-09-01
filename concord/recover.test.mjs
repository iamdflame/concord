import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from './ladder.mjs';
import { runSaga, OUTCOME } from './saga.mjs';
import { Journal, MemoryStore } from './journal.mjs';
import { recover } from './recover.mjs';

const withStatus = (steps) => ({ ...steps, status: { tool: 'lookup' } });
const reservable = (id) => ({ id, input: {}, protocol: { steps: withStatus({
  reserve: { tool: 'hold' }, confirm: { tool: 'ticket' }, cancel: { tool: 'release' } }) } });
const compensable = (id) => ({ id, input: {}, protocol: { steps: withStatus({
  execute: { tool: 'book' }, compensate: { tool: 'refund' } }) } });
const irreversible = (id) => ({ id, input: {}, protocol: { steps: withStatus({ execute: { tool: 'charge' } }) } });
const noStatus = (id) => ({ id, input: {}, protocol: { steps: {
  execute: { tool: 'book' }, compensate: { tool: 'refund' } } } });

/**
 * Vendors that remember what they did, so `status` can answer truthfully and
 * a reversal can be counted. dieBefore throws without acting; dieAfter acts and
 * then throws, which is the case that strands money.
 */
function world({ dieBefore = null, dieAfter = null } = {}) {
  const performed = new Map();   // idempotencyKey -> result
  const reversals = [];
  let n = 0;

  const call = async (id, tool, args, { idempotencyKey, step }) => {
    if (step === 'status') {
      // Mirrors what bind() does over WebMCP: the call's own idempotency key is
      // merged into the arguments, so a probe must not name its parameter the
      // same thing or it reads back the key of the asking.
      const merged = { ...args, idempotencyKey };
      const prior = performed.get(merged.lookupKey);
      return { happened: Boolean(prior), result: prior ?? null };
    }
    n += 1;
    const die = (which) => {
      const err = new Error(`process died ${which} call ${n}`);
      err.fatal = true;                 // a dead process does not unwind
      throw err;
    };
    if (n === dieBefore) die('before');

    if (performed.has(idempotencyKey)) return { ...performed.get(idempotencyKey), replayed: true };
    const result = { ref: `${id}-${step}`, ok: true };
    performed.set(idempotencyKey, result);
    if (['cancel', 'compensate'].includes(step)) reversals.push(`${id}.${step}`);

    if (n === dieAfter) die('after');
    return result;
  };

  return { call, performed, reversals, calls: () => n };
}

const setup = (participants) => ({ planned: plan(participants), participants });

async function crashAt(participants, where) {
  const journal = new Journal(new MemoryStore());
  const w = world(where);
  const { planned } = setup(participants);
  await assert.rejects(() => runSaga({ plan: planned, participants, call: w.call, journal }),
    (e) => e.fatal === true);
  return { journal, w };
}

test('a dead process does not unwind — that is what recovery is for', async () => {
  const participants = [reservable('fly'), compensable('stay'), irreversible('visa')];
  const { w } = await crashAt(participants, { dieBefore: 3 });
  assert.deepEqual(w.reversals, [], 'nothing should have been reversed by a process that stopped');
});

test('crashing after a vendor acted still finds and reverses the effect', async () => {
  // The money-stranding case: the hotel was charged, and the coordinator died
  // before the reply was recorded. Only the hotel knows it happened.
  const participants = [reservable('fly'), compensable('stay'), irreversible('visa')];
  const { journal, w } = await crashAt(participants, { dieAfter: 2 });

  const before = await journal.incomplete();
  assert.equal(before[0].uncertain.length, 1, 'the interrupted call must read as uncertain, not as failed');
  assert.equal(before[0].uncertain[0].vendor, 'stay');

  const [report] = await recover({ journal, participants, call: w.call });
  assert.equal(report.outcome, OUTCOME.UNWOUND);
  assert.deepEqual(w.reversals, ['stay.compensate', 'fly.cancel']);
  assert.deepEqual(await journal.incomplete(), [], 'a recovered saga is settled');
});

test('a saga that finished is recognised as committed, not undone', async () => {
  // The log of a saga that completed and died before its settled marker looks
  // identical to one that stopped half way. Treating them the same reversed a
  // hotel booking underneath a ticketed flight and called it "nothing stands".
  const participants = [reservable('fly'), compensable('stay')];
  const { journal, w } = await crashAt(participants, { dieAfter: 3 });   // all 3 calls done

  const [report] = await recover({ journal, participants, call: w.call });
  assert.equal(report.outcome, OUTCOME.COMMITTED);
  assert.deepEqual(w.reversals, [], 'a completed commitment must not be unwound');
  assert.equal(report.stands.length, 3);
});

test('a confirmed reservation is not cancelled — it is a booking, not a hold', async () => {
  // fly.reserve, stay.execute, fly.confirm, then die. The flight is ticketed,
  // so releasing the seat does nothing at the vendor and lies in the report.
  const participants = [reservable('fly'), compensable('stay'), irreversible('visa')];
  const { journal, w } = await crashAt(participants, { dieAfter: 4 });

  const [report] = await recover({ journal, participants, call: w.call });
  assert.ok(!w.reversals.includes('fly.cancel'), 'a ticketed seat must not be released');
  assert.ok(report.stands.some((s) => s.vendor === 'fly' && s.step === 'confirm'));
});

test('recovery is correct at every crash point, and never double-reverses', async () => {
  const participants = [reservable('fly'), compensable('stay'), irreversible('visa')];
  const total = 4;    // fly.reserve, stay.execute, visa.execute, fly.confirm

  // What the plan required. A saga holding all of these is complete.
  const required = ['fly.reserve', 'fly.confirm', 'stay.execute', 'visa.execute'];

  for (let at = 1; at <= total; at++) {
    for (const when of ['dieBefore', 'dieAfter']) {
      const { journal, w } = await crashAt(participants, { [when]: at });

      // Snapshot before recovery, or the reversals it performs pollute the oracle.
      const forward = [...w.performed.keys()].map((k) => k.split('.').slice(1).join('.'));
      const confirmed = new Set(forward.filter((s) => s.endsWith('.confirm')).map((s) => s.split('.')[0]));
      const complete = required.every((r) => forward.includes(r));

      // The correct expectation: nothing if the saga finished; otherwise every
      // step that happened, is still reversible, and was not superseded by a
      // confirm that turned it final.
      const expected = complete ? [] : forward.flatMap((s) => {
        const [vendor, step] = s.split('.');
        if (step === 'confirm') return [];
        if (step === 'reserve') return confirmed.has(vendor) ? [] : [`${vendor}.cancel`];
        if (step === 'execute') return vendor === 'stay' ? ['stay.compensate'] : [];
        return [];
      });

      await recover({ journal, participants, call: w.call });

      assert.deepEqual([...w.reversals].sort(), expected.sort(),
        `${when} ${at}: reversals did not match what should have been undone`);
      assert.equal(new Set(w.reversals).size, w.reversals.length,
        `${when} ${at}: something was reversed twice`);
    }
  }
});

test('unwinding, then crashing, then recovering does not compensate twice', async () => {
  // The live unwind and recovery once derived the compensation key differently,
  // so the vendor saw a key it had never seen and refunded a second time.
  const participants = [reservable('fly'), compensable('stay'), irreversible('visa')];
  const journal = new Journal(new MemoryStore());
  const w = world();

  // Fail the irreversible step so the live unwind runs, then recover on top.
  const failing = async (id, tool, args, opts) => {
    if (id === 'visa' && opts.step === 'execute') throw new Error('fee declined');
    return w.call(id, tool, args, opts);
  };
  await runSaga({ plan: plan(participants), participants, call: failing, journal });
  const afterUnwind = [...w.reversals];

  await recover({ journal, participants, call: w.call });
  assert.deepEqual(w.reversals, afterUnwind,
    'recovery re-ran a compensation the live unwind had already performed');
});

test('an irreversible step that did happen is reported, not silently dropped', async () => {
  const participants = [reservable('fly'), irreversible('visa')];
  // Die after the consular fee is taken. It cannot be undone by anyone.
  const { journal, w } = await crashAt(participants, { dieAfter: 2 });
  const [report] = await recover({ journal, participants, call: w.call });

  assert.equal(report.outcome, OUTCOME.IN_DOUBT);
  // A step nothing can undo is not a failed reversal; it is something that
  // stands. Reporting it as an attempted-and-failed undo implies someone tried.
  const stuck = report.stands.find((s) => s.vendor === 'visa');
  assert.match(stuck.why, /cannot be undone/);
  assert.ok(w.reversals.includes('fly.cancel'), 'the reversible half must still be released');
});

test('a vendor with no status step is reported unresolved, never assumed', async () => {
  const participants = [reservable('fly'), noStatus('stay')];
  const { journal, w } = await crashAt(participants, { dieAfter: 2 });
  const [report] = await recover({ journal, participants, call: w.call });

  assert.equal(report.outcome, OUTCOME.IN_DOUBT);
  assert.equal(report.unresolved.length, 1);
  assert.match(report.unresolved[0].why, /declares no status step/);
  // Assuming it did not happen would strand the charge; assuming it did would
  // refund a booking that was never made. Neither is done.
  assert.ok(!w.reversals.includes('stay.compensate'));
});

test('a completed saga leaves nothing for recovery to do', async () => {
  const participants = [reservable('fly'), compensable('stay')];
  const journal = new Journal(new MemoryStore());
  const w = world();
  const { planned } = setup(participants);
  const out = await runSaga({ plan: planned, participants, call: w.call, journal });

  assert.equal(out.outcome, OUTCOME.COMMITTED);
  assert.deepEqual(await journal.incomplete(), []);
  assert.deepEqual(await recover({ journal, participants, call: w.call }), []);
});
