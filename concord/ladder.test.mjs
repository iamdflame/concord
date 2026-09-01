import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, classify, describe, GUARANTEE, RUNG, PlanError } from './ladder.mjs';

const reservable = (id, dependsOn) => ({ id, dependsOn, protocol: { steps: {
  reserve: { tool: 'hold', ttlSeconds: 900 }, confirm: { tool: 'confirm' }, cancel: { tool: 'release' } } } });
const compensable = (id, dependsOn) => ({ id, dependsOn, protocol: { steps: {
  execute: { tool: 'book' }, compensate: { tool: 'cancel', refund: 'full' } } } });
const irreversible = (id, dependsOn) => ({ id, dependsOn, protocol: { steps: { execute: { tool: 'charge' } } } });

test('classify reads the rung from the declared protocol', () => {
  assert.equal(classify(reservable('a')).rung, RUNG.RESERVABLE);
  assert.equal(classify(compensable('a')).rung, RUNG.COMPENSABLE);
  assert.equal(classify(irreversible('a')).rung, RUNG.IRREVERSIBLE);
});

test('a participant declaring no protocol is a planning error, not a guess', () => {
  assert.throws(() => classify({ id: 'mystery', protocol: { steps: {} } }), PlanError);
});

test('all reservable is fully atomic', () => {
  const p = plan([reservable('fly'), reservable('stay')]);
  assert.equal(p.guarantee, GUARANTEE.ATOMIC);
  assert.equal(p.pointOfNoReturn, null);
  assert.equal(p.caveats.length, 0);
});

test('a compensable participant downgrades the promise and says why', () => {
  const p = plan([reservable('fly'), compensable('stay')]);
  assert.equal(p.guarantee, GUARANTEE.COMPENSATED);
  assert.match(p.caveats.join(' '), /briefly real/);
  // Reversible work is front-loaded, so a failure costs as little as possible.
  assert.deepEqual(p.order, ['fly', 'stay']);
});

test('one irreversible participant is allowed, but only last', () => {
  const p = plan([irreversible('visa'), reservable('fly'), compensable('stay')]);
  assert.equal(p.guarantee, GUARANTEE.BOUNDED);
  assert.equal(p.order.at(-1), 'visa');
  assert.equal(p.pointOfNoReturn, 2);
  assert.match(p.caveats.join(' '), /cannot be reversed/);
});

test('two irreversible participants are refused, before anything runs', () => {
  const p = plan([irreversible('visa'), irreversible('permit'), reservable('fly')]);
  assert.equal(p.guarantee, GUARANTEE.REFUSED);
  assert.match(p.refusal, /visa and permit/);
  assert.match(p.refusal, /nothing can undo the first/);
  assert.match(describe(p), /^Cannot be made atomic/);
});

test('an irreversible step that something must follow is refused', () => {
  // The flight can only be booked once the visa is paid for, so the
  // irreversible step cannot be moved to the end. No honest promise exists.
  const p = plan([irreversible('visa'), reservable('fly', ['visa'])]);
  assert.equal(p.guarantee, GUARANTEE.REFUSED);
  assert.match(p.refusal, /must run after it/);
});

test('declared dependencies are respected in the order', () => {
  const p = plan([reservable('stay', ['fly']), reservable('fly')]);
  assert.deepEqual(p.order, ['fly', 'stay']);
});

test('a dependency cycle is a planning error', () => {
  assert.throws(() => plan([reservable('a', ['b']), reservable('b', ['a'])]),
    (e) => e instanceof PlanError && /cycle/.test(e.message));
});

test('an empty plan is refused rather than trivially satisfied', () => {
  assert.throws(() => plan([]), PlanError);
});
