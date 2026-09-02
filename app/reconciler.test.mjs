// The reconciler, without a browser.
//
// Every test here corresponds to a way the registered set can end up saying
// something untrue about what an agent may do. That set is the permission
// model, so "untrue" here means either a tool an agent should not have or a
// commitment reported as failed after it committed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reconciler, budget } from './reconciler.mjs';

/** A model context that behaves the way WebMCP does: abort is the unregister. */
function fakeContext() {
  const tools = new Map();
  return {
    tools,
    names: () => [...tools.keys()].sort(),
    async registerTool(def, { signal } = {}) {
      tools.set(def.name, def);
      signal?.addEventListener('abort', () => tools.delete(def.name), { once: true });
    },
  };
}

const def = (name, execute = async () => ({ ok: name })) => ({
  title: name,
  description: name,
  inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
  execute,
  refuse: (why) => ({ refused: true, reason: why }),
});

const tick = () => new Promise((r) => setTimeout(r, 0));

test('a tool that stops being wanted stops being registered', async () => {
  const mc = fakeContext();
  const r = new Reconciler(mc);
  const defs = { a: def('a'), b: def('b') };

  await r.sync(['a', 'b'], defs);
  assert.deepEqual(mc.names(), ['a', 'b']);
  assert.deepEqual(r.names, ['a', 'b']);

  await r.sync(['a'], defs);
  assert.deepEqual(mc.names(), ['a'], 'b is gone from the context, not merely disabled');
  assert.deepEqual(r.names, ['a']);
});

test('each tool has its own controller, so removing one keeps the others', async () => {
  // One controller for the batch was the obvious implementation and it takes
  // the whole surface down every time a single tool stops being permitted.
  const mc = fakeContext();
  const r = new Reconciler(mc);
  const defs = { a: def('a'), b: def('b'), c: def('c') };
  await r.sync(['a', 'b', 'c'], defs);
  await r.sync(['b'], defs);
  assert.deepEqual(mc.names(), ['b']);
  await r.sync(['a', 'b'], defs);
  assert.deepEqual(mc.names(), ['a', 'b']);
});

test('a running call is not cancelled by losing its permission', async () => {
  // This is the hazard that fires on every single commitment: commit() marks
  // itself spent and the surface reconciles it away while its own execute is
  // still running. Unregistering a tool mid-call tells the agent the call
  // failed -- and a commitment that reports failure after committing is the
  // worst outcome this project has.
  const mc = fakeContext();
  const r = new Reconciler(mc);
  let release;
  const held = new Promise((res) => { release = res; });
  const defs = { commit: def('commit', async () => { await held; return { committed: true }; }) };

  await r.sync(['commit'], defs);
  const call = mc.tools.get('commit').execute({});

  // The permission is withdrawn while the call is in flight.
  await r.sync([], defs);
  assert.deepEqual(mc.names(), ['commit'], 'still registered, because it is still running');

  release();
  assert.deepEqual(await call, { committed: true }, 'the call completed rather than being cancelled');

  await tick();
  await tick();
  assert.deepEqual(mc.names(), [], 'and it is retired once it has settled');
});

test('reconciles do not interleave', async () => {
  // registerTool is async. Two overlapping reconciles produce a set neither of
  // them asked for, and the tool that goes missing is silent about it.
  const mc = fakeContext();
  let gate;
  const slow = new Promise((res) => { gate = res; });
  let first = true;
  const ctx = {
    ...mc,
    async registerTool(d, o) {
      if (first) { first = false; await slow; }
      return mc.registerTool(d, o);
    },
  };
  const r = new Reconciler(ctx);
  const defs = { a: def('a'), b: def('b') };

  const one = r.sync(['a'], defs);
  const two = r.sync(['a', 'b'], defs);
  gate();
  await Promise.all([one, two]);
  assert.deepEqual(mc.names(), ['a', 'b'], 'the later intent wins, and nothing is lost on the way');
});

test('arguments the schema did not describe are refused, with a suggestion', async () => {
  // The browser does not validate inputSchema. A typo'd key arrives as
  // undefined and gets acted on, which for a commitment means committing
  // something other than what was asked for.
  const mc = fakeContext();
  const r = new Reconciler(mc);
  await r.sync(['a'], { a: def('a') });

  const wrong = await mc.tools.get('a').execute({ X: 'hello' });
  assert.equal(wrong.refused, true);
  assert.match(wrong.reason, /did you mean "x"/);

  const alien = await mc.tools.get('a').execute({ nonsense: 1 });
  assert.match(alien.reason, /has no parameter "nonsense"/);
  assert.match(alien.reason, /It takes x/);
});

test('a missing required argument is named rather than acted on', async () => {
  const mc = fakeContext();
  const r = new Reconciler(mc);
  const d = def('a');
  d.inputSchema.required = ['x'];
  await r.sync(['a'], { a: d });
  const out = await mc.tools.get('a').execute({});
  assert.match(out.reason, /needs x/);
});

test('a long answer is shortened without becoming invalid', () => {
  // Trimming the serialised string produces broken JSON, which is worse than
  // either the long version or an honest summary.
  const long = { vendors: Array.from({ length: 60 }, (_, i) => ({ id: `v${i}`, note: 'x'.repeat(60) })) };
  const small = budget(long, 800);
  assert.ok(JSON.stringify(small).length <= 800);
  assert.ok(small.vendors.length < 60);
  assert.equal(small.vendors.length + small.vendorsOmitted, 60, 'it says how many it left out');
  assert.deepEqual(small.vendors[0], long.vendors[0], 'and the entries it kept are intact');
});

test('what is small enough is left exactly alone', () => {
  const value = { a: 1, list: [1, 2, 3] };
  assert.deepEqual(budget(value, 1800), value);
});
