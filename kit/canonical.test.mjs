import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from './canonical.mjs';

test('insertion order never changes the bytes', () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('it agrees with JSON.stringify wherever JSON is already canonical', () => {
  // The interop property: a verifier written against plain JSON must reach the
  // same bytes for anything whose keys are already in order.
  for (const v of [
    { a: 1, b: 'two', c: [1, 2, 3] },
    { a: { b: { c: null } } },
    [1, 'two', true, null],
    { a: 1e21, b: -0, c: 0.1 },
    'plain', 42, true, null,
  ]) {
    assert.equal(canonical(v), JSON.stringify(v), `diverged on ${JSON.stringify(v)}`);
  }
});

test('a member JSON omits is omitted, not turned into null', () => {
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonical({ a: undefined, b: 1 }), JSON.stringify({ a: undefined, b: 1 }));
  assert.equal(canonical({ f() {}, b: 1 }), '{"b":1}');
});

test('toJSON is honoured, so a Date is its JSON form and not an empty object', () => {
  assert.equal(canonical({ d: new Date(0) }), '{"d":"1970-01-01T00:00:00.000Z"}');
  assert.equal(canonical({ d: new Date(0) }), JSON.stringify({ d: new Date(0) }));
});

test('a value with no JSON meaning is refused rather than silently nulled', () => {
  // JSON.stringify writes null for these, which would let two parties sign
  // different meanings of identical bytes.
  assert.throws(() => canonical({ n: NaN }), /NaN cannot be canonicalised/);
  assert.throws(() => canonical({ n: Infinity }), /Infinity cannot be canonicalised/);
});

test('array holes follow JSON and become null', () => {
  assert.equal(canonical([1, undefined, 3]), '[1,null,3]');
  assert.equal(canonical([1, undefined, 3]), JSON.stringify([1, undefined, 3]));
});

test('property names sort as UTF-16 code units, per RFC 8785', () => {
  const out = canonical({ '😀': 1, 'é': 2, z: 3, a: 4 });
  assert.equal(out, '{"a":4,"z":3,"é":2,"😀":1}');
});

test('a signed statement canonicalises identically however it was built', () => {
  const a = { sagaId: 's', origin: 'https://x', vendor: 'fly', parties: ['fly', 'stay'],
              step: 'confirm', idempotencyKey: 'k', at: '2026-01-01T00:00:00Z', result: { ok: true } };
  const b = { result: { ok: true }, at: '2026-01-01T00:00:00Z', idempotencyKey: 'k',
              step: 'confirm', parties: ['fly', 'stay'], vendor: 'fly', origin: 'https://x', sagaId: 's' };
  assert.equal(canonical(a), canonical(b));
});
