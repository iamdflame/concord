import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, classify, describe, GUARANTEE, RUNG, PlanError } from './ladder.mjs';

// Real vendors get `status` for free from the kit, so fixtures carry it too --
// otherwise every plan picks up the "cannot be asked what happened" caveat and
// the tests stop testing what they name.
const ws = (steps) => ({ ...steps, status: { tool: 'lookup' } });
const reservable = (id, dependsOn) => ({ id, dependsOn, protocol: { steps: ws({
  reserve: { tool: 'hold', ttlSeconds: 900 }, confirm: { tool: 'confirm' }, cancel: { tool: 'release' } }) } });
const compensable = (id, dependsOn) => ({ id, dependsOn, protocol: { steps: ws({
  execute: { tool: 'book' }, compensate: { tool: 'cancel', refund: 'full' } }) } });
const irreversible = (id, dependsOn) => ({ id, dependsOn, protocol: { steps: ws({ execute: { tool: 'charge' } }) } });
const unaskable = (id) => ({ id, protocol: { steps: {
  execute: { tool: 'book' }, compensate: { tool: 'refund' } } } });

test('classify reads the rung from the declared protocol', () => {
  assert.equal(classify(reservable('a')).rung, RUNG.RESERVABLE);
  assert.equal(classify(compensable('a')).rung, RUNG.COMPENSABLE);
  assert.equal(classify(irreversible('a')).rung, RUNG.IRREVERSIBLE);
});

test('a participant declaring no usable protocol is refused, not thrown', () => {
  // "No honest promise is available" is one concept, so it has one failure mode.
  const { rung, unusable } = classify({ id: 'mystery', protocol: { steps: {} } });
  assert.equal(rung, null);
  assert.match(unusable, /not a commitment protocol/);

  const p = plan([reservable('fly'), { id: 'half', protocol: { steps: { reserve: { tool: 'hold' } } } }]);
  assert.equal(p.guarantee, GUARANTEE.REFUSED);
  assert.match(p.refusal, /half declares only reserve/);
});

test('all reservable is all-or-nothing, and says so without overclaiming', () => {
  const p = plan([reservable('fly'), reservable('stay')]);
  assert.equal(p.guarantee, GUARANTEE.ATOMIC);
  assert.equal(p.pointOfNoReturn, null);

  // Confirm is a sequence, not an instant. Calling that "fully atomic" was the
  // one place the project made the promise it exists to refuse.
  assert.doesNotMatch(describe(p), /fully atomic/i);
  assert.match(describe(p), /if a confirm then fails/i);
  assert.match(p.caveats.join(' '), /sequence, not an instant/);
});

test('a single reservable vendor has no fan-out to warn about', () => {
  const p = plan([reservable('fly')]);
  assert.equal(p.guarantee, GUARANTEE.ATOMIC);
  assert.equal(p.caveats.length, 0);
});

test('a vendor that cannot be asked what happened is named before you commit', () => {
  const p = plan([reservable('fly'), unaskable('stay')]);
  assert.equal(p.recoverable, false);
  assert.match(p.caveats.join(' '), /stay cannot be asked whether a step happened/);
  assert.match(p.caveats.join(' '), /permanent unknown/);

  assert.equal(plan([reservable('fly'), compensable('stay')]).recoverable, true);
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
