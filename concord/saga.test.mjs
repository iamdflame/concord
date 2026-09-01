import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from './ladder.mjs';
import { runSaga, OUTCOME } from './saga.mjs';

const reservable = (id, input) => ({ id, input, protocol: { steps: {
  reserve: { tool: 'hold', ttlSeconds: 900 }, confirm: { tool: 'ticket' }, cancel: { tool: 'release' } } } });
const compensable = (id, input) => ({ id, input, protocol: { steps: {
  execute: { tool: 'book' }, compensate: { tool: 'refund', refund: 'full' } } } });
const irreversible = (id, input) => ({ id, input, protocol: { steps: { execute: { tool: 'charge' } } } });

/** A recording vendor bank. `fail` names "<id>.<step>" calls that should throw. */
function bank({ fail = new Set(), failTimes = {} } = {}) {
  const calls = [];
  const attempts = new Map();
  return {
    calls,
    async call(id, tool, args, { idempotencyKey, step }) {
      const sig = `${id}.${step}`;
      const n = (attempts.get(sig) ?? 0) + 1;
      attempts.set(sig, n);
      calls.push({ id, step, tool, args, idempotencyKey, attempt: n });
      if (fail.has(sig) && (failTimes[sig] === undefined || n <= failTimes[sig])) {
        throw new Error(`${sig} failed`);
      }
      return { ref: `${id}-ref`, ok: true };
    },
    steps: () => calls.map((c) => `${c.id}.${c.step}`),
  };
}

const withPlan = (participants) => ({ planned: plan(participants), participants });

test('a fully reservable plan reserves everything before confirming anything', async () => {
  const v = bank();
  const { planned, participants } = withPlan([reservable('fly'), reservable('stay')]);
  const out = await runSaga({ plan: planned, participants, call: v.call });
  assert.equal(out.outcome, OUTCOME.COMMITTED);
  assert.deepEqual(v.steps(), ['fly.reserve', 'stay.reserve', 'fly.confirm', 'stay.confirm']);
});

test('confirm runs after the irreversible step, never before it', async () => {
  const v = bank();
  const { planned, participants } = withPlan([irreversible('visa'), reservable('fly'), compensable('stay')]);
  const out = await runSaga({ plan: planned, participants, call: v.call });
  assert.equal(out.outcome, OUTCOME.COMMITTED);
  assert.deepEqual(v.steps(), ['fly.reserve', 'stay.execute', 'visa.execute', 'fly.confirm']);
});

test('a failure during reserve releases the holds already taken', async () => {
  const v = bank({ fail: new Set(['stay.reserve']) });
  const { planned, participants } = withPlan([reservable('fly'), reservable('stay')]);
  const out = await runSaga({ plan: planned, participants, call: v.call });
  assert.equal(out.outcome, OUTCOME.UNWOUND);
  assert.deepEqual(v.steps(), ['fly.reserve', 'stay.reserve', 'fly.cancel']);
});

test('a failure at the point of no return unwinds everything before it', async () => {
  const v = bank({ fail: new Set(['visa.execute']) });
  const { planned, participants } = withPlan([irreversible('visa'), reservable('fly'), compensable('stay')]);
  const out = await runSaga({ plan: planned, participants, call: v.call });
  assert.equal(out.outcome, OUTCOME.UNWOUND);
  // Compensations run newest-first, then reservations are released.
  assert.deepEqual(v.steps(),
    ['fly.reserve', 'stay.execute', 'visa.execute', 'stay.compensate', 'fly.cancel']);
  assert.equal(out.committed.length, 0);
});

test('unwind reverses in the opposite order to execution', async () => {
  const v = bank({ fail: new Set(['third.reserve']) });
  const { planned, participants } = withPlan([reservable('first'), reservable('second'), reservable('third')]);
  await runSaga({ plan: planned, participants, call: v.call });
  const released = v.steps().filter((s) => s.endsWith('.cancel'));
  assert.deepEqual(released, ['second.cancel', 'first.cancel']);
});

test('confirm is retried under the same idempotency key', async () => {
  const v = bank({ fail: new Set(['fly.confirm']), failTimes: { 'fly.confirm': 2 } });
  const { planned, participants } = withPlan([reservable('fly')]);
  const out = await runSaga({ plan: planned, participants, call: v.call, retryDelayMs: 1 });
  assert.equal(out.outcome, OUTCOME.COMMITTED);
  const confirms = v.calls.filter((c) => c.step === 'confirm');
  assert.equal(confirms.length, 3);
  assert.equal(new Set(confirms.map((c) => c.idempotencyKey)).size, 1,
    'a retry must reuse the key, or the vendor cannot tell it is the same request');
});

test('exhausted confirm past the point of no return reports IN DOUBT, not success', async () => {
  const v = bank({ fail: new Set(['fly.confirm']) });
  const { planned, participants } = withPlan([irreversible('visa'), reservable('fly')]);
  const out = await runSaga({ plan: planned, participants, call: v.call, retryDelayMs: 1 });
  assert.equal(out.outcome, OUTCOME.IN_DOUBT);
  // It must name what is stranded rather than reporting a generic failure.
  assert.match(out.stranded.join(' '), /visa has committed and cannot be reversed/);
  assert.match(out.stranded.join(' '), /fly holds a reservation that was never confirmed/);
  // And it must not have tried to cancel a confirmed-or-committed world.
  assert.equal(v.steps().filter((s) => s.endsWith('.cancel')).length, 0);
});

test('a failed compensation is reported, never swallowed', async () => {
  const v = bank({ fail: new Set(['visa.execute', 'stay.compensate']) });
  const { planned, participants } = withPlan([irreversible('visa'), compensable('stay')]);
  const out = await runSaga({ plan: planned, participants, call: v.call });
  assert.equal(out.outcome, OUTCOME.IN_DOUBT);
  assert.equal(out.failures[0].id, 'stay');
  assert.equal(out.failures[0].step, 'compensate');
});

test('a refused plan runs nothing at all', async () => {
  const v = bank();
  const { planned, participants } = withPlan([irreversible('visa'), irreversible('permit')]);
  const out = await runSaga({ plan: planned, participants, call: v.call });
  assert.equal(out.outcome, OUTCOME.REFUSED);
  assert.deepEqual(v.steps(), [], 'refusing after touching a vendor is not refusing');
});

test('the journal records the point of no return before crossing it', async () => {
  const v = bank();
  const { planned, participants } = withPlan([irreversible('visa'), reservable('fly')]);
  const out = await runSaga({ plan: planned, participants, call: v.call });
  const types = out.journal.map((e) => e.type);
  assert.ok(types.indexOf('point_of_no_return') < types.indexOf('committed'));
  assert.equal(out.journal.find((e) => e.type === 'plan').guarantee, 'bounded');
});

test('a vendor that never answers is abandoned, not waited on forever', async () => {
  // The coordinator cannot depend on a vendor honouring cancellation; a
  // deadline that only the callee enforces is not a deadline.
  const participants = [reservable('fly')];
  const silent = () => new Promise(() => {});
  const out = await runSaga({
    plan: plan(participants), participants, call: silent, callTimeoutMs: 60,
  });
  assert.equal(out.outcome, OUTCOME.UNWOUND);
  assert.match(out.cause, /did not answer reserve within 60ms/);
});

test('an expired hold is diagnosed before confirm, not discovered by failing', async () => {
  const slow = { id: 'stay', input: {}, protocol: { steps: {
    execute: { tool: 'book' }, compensate: { tool: 'refund' } } } };
  const brief = { id: 'fly', input: {}, protocol: { steps: {
    reserve: { tool: 'hold', ttlSeconds: 0.05 },   // 50ms
    confirm: { tool: 'ticket' }, cancel: { tool: 'release' } } } };

  const v = bank();
  const call = async (...args) => {
    if (args[3].step === 'execute') await new Promise((r) => setTimeout(r, 120));
    return v.call(...args);
  };
  const out = await runSaga({ plan: plan([brief, slow]), participants: [brief, slow], call });

  assert.equal(out.outcome, OUTCOME.UNWOUND);
  assert.match(out.cause, /0\.05s hold expired before this could be confirmed/);
  // And the expiry is reported as such rather than surfacing as a mystery.
  assert.ok(out.journal.some((e) => e.type === 'hold_expired'));
  // The hotel booking made under that hold is reversed.
  assert.ok(v.steps().includes('stay.compensate'));
});

test('a vendor that answers "no" is not asked again', async () => {
  // Retrying a decision is not resilience; it is refusing to hear it.
  const v = bank();
  const declining = async (id, tool, args, opts) => {
    if (opts.step === 'confirm') throw Object.assign(new Error('no live hold'), { terminal: true });
    return v.call(id, tool, args, opts);
  };
  const ps = [reservable('fly')];
  const out = await runSaga({ plan: plan(ps), participants: ps, call: declining, retryDelayMs: 1 });

  assert.equal(out.outcome, OUTCOME.IN_DOUBT);
  assert.equal(out.journal.filter((e) => e.type === 'confirm').length, 1,
    'a terminal answer must be asked exactly once');
  assert.ok(out.journal.some((e) => e.type === 'confirm_declined'));
});

test('a transient failure is retried with growing, jittered waits', async () => {
  const v = bank({ fail: new Set(['fly.confirm']), failTimes: { 'fly.confirm': 3 } });
  const ps = [reservable('fly')];
  const out = await runSaga({
    plan: plan(ps), participants: ps, call: v.call, retryDelayMs: 4, retryCapMs: 40,
  });

  assert.equal(out.outcome, OUTCOME.COMMITTED, 'it should survive three transient failures');
  const waits = out.journal.filter((e) => e.type === 'confirm_retry').map((e) => e.waitMs);
  assert.equal(waits.length, 3);
  // Full jitter: each wait is somewhere in [0, cap for that attempt], so the
  // ceiling grows even though any individual draw may not.
  assert.ok(waits.every((w) => w >= 0 && w <= 40), `waits outside the cap: ${waits}`);
});
