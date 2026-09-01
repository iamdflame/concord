import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from './ladder.mjs';
import { runSaga, OUTCOME } from './saga.mjs';
import { Journal, MemoryStore, PHASE } from './journal.mjs';

const reservable = (id) => ({ id, input: {}, protocol: { steps: {
  reserve: { tool: 'hold' }, confirm: { tool: 'ticket' }, cancel: { tool: 'release' } } } });

test('intent is written before the call, and the result after', async () => {
  const journal = new Journal(new MemoryStore());
  const order = [];
  const call = async (id, tool, args, { step }) => {
    order.push(`call:${id}.${step}`);
    return { ref: 'r' };
  };
  const original = journal.intent.bind(journal);
  journal.intent = async (...a) => { order.push(`intent:${a[1]}.${a[2]}`); return original(...a); };

  const ps = [reservable('fly')];
  await runSaga({ plan: plan(ps), participants: ps, call, journal });

  assert.deepEqual(order.slice(0, 2), ['intent:fly.reserve', 'call:fly.reserve'],
    'a call that happens before its intent is recorded is one recovery can never find');
});

test('a journal that cannot write stops the saga instead of acting unrecorded', async () => {
  // A full quota used to throw out of the write that was meant to make the
  // saga recoverable, aborting it as an unhandled rejection with no report.
  const store = new MemoryStore();
  store.append = async () => { throw new Error('QuotaExceededError'); };
  const journal = new Journal(store);

  let called = false;
  const ps = [reservable('fly')];
  const out = await runSaga({
    plan: plan(ps), participants: ps, journal,
    call: async () => { called = true; return { ref: 'r' }; },
  });

  assert.equal(called, false, 'nothing may happen that could not be recorded');
  // No recoverable commitment is available, which is the same answer the ladder
  // gives to any plan it cannot honestly promise.
  assert.equal(out.outcome, OUTCOME.REFUSED);
  assert.match(out.refusal, /commitment log cannot be written/);
});

test('a journal that fails mid-saga stops before the next unrecorded step', async () => {
  const store = new MemoryStore();
  const journal = new Journal(store);
  let writes = 0;
  const real = store.append.bind(store);
  store.append = async (row) => {
    if (++writes > 3) throw new Error('QuotaExceededError');   // fails after reserve
    return real(row);
  };

  const steps = [];
  const ps = [reservable('fly'), { id: 'stay', input: {}, protocol: { steps: {
    execute: { tool: 'book' }, compensate: { tool: 'refund' } } } }];
  const out = await runSaga({ plan: plan(ps), participants: ps, journal,
    call: async (id, t, a, { step }) => { steps.push(`${id}.${step}`); return { ref: 'r' }; } });

  assert.ok(!steps.includes('stay.execute'), 'a step that could not be recorded must not be taken');
  assert.match(out.cause, /cannot record intent to execute on stay/);
  assert.ok(out.journal.some((e) => e.type === 'journal_failed'));
  // The reversal really happened, so the report must survive the log failing.
  assert.match(out.unrecorded, /could not be recorded/);
  assert.ok(steps.includes('fly.cancel'), 'the outstanding hold is still released');
});

test('settled sagas are pruned; unsettled ones are never touched', async () => {
  const store = new MemoryStore();
  const journal = new Journal(store);
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;

  await store.append({ phase: PHASE.INTENT, sagaId: 'old', vendor: 'fly', step: 'reserve', idempotencyKey: 'k1', at: old });
  await store.append({ phase: PHASE.SETTLED, sagaId: 'old', outcome: 'committed', at: old });
  await store.append({ phase: PHASE.INTENT, sagaId: 'live', vendor: 'fly', step: 'reserve', idempotencyKey: 'k2', at: Date.now() });

  const dropped = await journal.prune(7 * 24 * 60 * 60 * 1000);
  assert.equal(dropped, 2);

  const left = await journal.read();
  assert.equal(left.length, 1);
  assert.equal(left[0].sagaId, 'live', 'an unsettled saga is still someone\'s money');
  assert.equal((await journal.incomplete()).length, 1);
});

test('a recently settled saga is kept, in case recovery is still being audited', async () => {
  const store = new MemoryStore();
  await store.append({ phase: PHASE.SETTLED, sagaId: 'yesterday', outcome: 'unwound', at: Date.now() - 60_000 });
  assert.equal(await new Journal(store).prune(7 * 24 * 60 * 60 * 1000), 0);
});
