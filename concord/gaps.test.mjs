// The tests that only exist because mutation testing said the suite was silent.
//
// Running every one of the 116 mutants rather than a sample of 60 dropped the
// score from 92% to 87% -- the sample was every Nth mutant, which is a stratified
// sample of a list sorted by file and operator, and it flattered the result. The
// number that means anything is the one over the whole set.
//
// Each test below names the mutant it kills. That is not decoration: a test
// whose reason for existing is not written down is a test the next person
// deletes, and these are exactly the tests that look redundant until you
// remember that nothing else was checking them.
//
// What is deliberately NOT here is anything asserting an implementation detail
// for the sake of the score. A mutant that survives because the code is
// genuinely equivalent under it is documented in evidence/mutants.txt and left
// alone; chasing it would mean writing a test that asserts the code is what it
// is, which measures nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan as buildPlan } from './ladder.mjs';
import { runSaga, OUTCOME } from './saga.mjs';
import { deriveOutcome, verifyInclusion, buildTree, proofFor, originResolver,
         verifyReceipt } from './receipt.mjs';
import { honestReceipt } from '../attacks/browser.mjs';

const ws = (steps) => ({ ...steps, status: { tool: 'lookup' } });
const RESERVABLE = ws({ reserve: { tool: 'hold' }, confirm: { tool: 'ticket' }, cancel: { tool: 'release' } });
const COMPENSABLE = ws({ execute: { tool: 'book' }, compensate: { tool: 'refund' } });
const IRREVERSIBLE = ws({ execute: { tool: 'charge' } });

const p = (id, steps) => ({ id, title: id, origin: `https://${id}.example`,
  protocol: { steps }, input: {} });

// ── ladder.mjs:188 — `compensable.length === 1 ? 'commits' : 'commit'` ───────

test('the guarantee reads as English for one compensable vendor and for several', () => {
  // A survivor that is only prose is still worth killing when the prose is the
  // product. This text is read aloud to a person before they accept, and
  // "Rowan House commit before the plan is settled" is the sentence that makes
  // a reader stop trusting the rest of it.
  const one = buildPlan([p('stay', COMPENSABLE), p('fly', RESERVABLE)]);
  const oneLine = one.caveats.find((c) => c.includes('before the plan is settled'));
  assert.ok(oneLine, 'no caveat described the compensable step');
  assert.match(oneLine, /^stay commits before the plan is settled\./,
    'a single compensable vendor should "commits", not "commit"');

  const two = buildPlan([p('stay', COMPENSABLE), p('room', COMPENSABLE), p('fly', RESERVABLE)]);
  const twoLine = two.caveats.find((c) => c.includes('before the plan is settled'));
  assert.match(twoLine, /^stay, room commit before the plan is settled\./,
    'two compensable vendors should "commit", not "commits"');
});

// ── saga.mjs:472 — `attempt < confirmRetries` ───────────────────────────────

test('confirm is attempted exactly as many times as it was told to', () => {
  // The mutant turns the last retry into one more or one fewer. Nothing was
  // counting, so both read as "it retried". A confirm budget that is silently
  // off by one is a vendor charged once more than the operator agreed to.
  const cases = [1, 2, 5];
  return Promise.all(cases.map(async (confirmRetries) => {
    let attempts = 0;
    const participants = [p('fly', RESERVABLE)];
    const call = async (id, tool, args, { step }) => {
      if (step !== 'confirm') return { ref: 'r' };
      attempts++;
      throw new Error('nope');
    };
    call.attestations = []; call.vendors = {};

    const out = await runSaga({ plan: buildPlan(participants), participants, call,
      confirmRetries, retryDelayMs: 0, sagaId: 'saga_gap' });

    assert.equal(out.outcome, OUTCOME.IN_DOUBT);
    assert.equal(attempts, confirmRetries,
      `confirmRetries=${confirmRetries} produced ${attempts} attempts`);
  }));
});

// ── saga.mjs:472 — `attempt < confirmRetries`, the backoff guard ────────────

test('the saga does not back off after it has stopped trying', async () => {
  // Not the attempt count: that is the loop bound one line above, and the test
  // before this one covers it. This is the guard on the *sleep*. With `<=` the
  // saga waits one more backoff after its final failed confirm -- holding a
  // reservation nobody is now going to confirm, and delaying the in-doubt
  // report by up to the retry cap while it does nothing.
  //
  // The wait is announced in the event, so this asserts a number rather than
  // timing anything. Three runs because the backoff is randomised and a single
  // draw could be zero by luck; three cannot.
  for (let run = 0; run < 3; run++) {
    const participants = [p('fly', RESERVABLE)];
    const call = async (id, tool, args, { step }) => {
      if (step === 'confirm') throw new Error('the airline will not confirm');
      return { ref: 'r' };
    };
    call.attestations = []; call.vendors = {};

    const out = await runSaga({ plan: buildPlan(participants), participants, call,
      confirmRetries: 1, retryDelayMs: 5_000, retryCapMs: 5_000, sagaId: 'saga_gap' });

    assert.equal(out.outcome, OUTCOME.IN_DOUBT);
    const retries = out.journal.filter((e) => e.type === 'confirm_retry');
    assert.equal(retries.length, 1, `expected one confirm_retry, got ${retries.length}`);
    assert.equal(retries.at(-1).waitMs, 0,
      'the saga scheduled a backoff after its last attempt, delaying the in-doubt report '
      + 'while a reservation was still outstanding');
  }
});

// ── saga.mjs:488 — `held.filter((h) => h !== record && !h.confirmed)` ────────

test('the stranded report names the other unconfirmed holds, and only those', async () => {
  // Two survivors lived here, one on each half of the condition. The list is
  // what a person is told is still outstanding after a commitment goes into
  // doubt, so naming the wrong holds -- or naming the failing one twice -- is
  // the report being wrong at the exact moment it matters most.
  const participants = [p('fly', RESERVABLE), p('rail', RESERVABLE), p('visa', IRREVERSIBLE)];
  const planned = buildPlan(participants);

  const call = async (id, tool, args, { step }) => {
    if (step === 'confirm') throw new Error('the airline will not confirm');
    return { ref: `${id}-ref` };
  };
  call.attestations = []; call.vendors = {};

  const out = await runSaga({ plan: planned, participants, call,
    confirmRetries: 1, retryDelayMs: 0, sagaId: 'saga_gap' });

  assert.equal(out.outcome, OUTCOME.IN_DOUBT);
  const also = out.stranded.filter((s) => s.includes('is also unconfirmed'));

  // Exactly one other hold, named once, and never the one that just failed.
  assert.equal(also.length, 1, `expected one other unconfirmed hold, got ${JSON.stringify(also)}`);
  const failing = out.stranded.find((s) => s.includes('never confirmed and will expire'));
  const failingId = failing.split(' ')[0];
  assert.ok(!also[0].startsWith(failingId),
    'the hold that failed to confirm was also listed as "also unconfirmed"');
  assert.match(also[0], /^(fly|rail) is also unconfirmed$/);
});

// ── receipt.mjs:116 — `if (p >= path.length) return false` ──────────────────

test('an inclusion proof whose path is too short is refused, not run off the end', async () => {
  // With `>` instead of `>=` the walk reads one past the end of the path,
  // hashes an undefined, and fails for the wrong reason -- or, on a different
  // tree shape, does not fail at all. A truncated proof is a forged proof and
  // has to be refused as one.
  const leaves = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `leaf-${x}`);
  const tree = await buildTree(leaves);

  for (let index = 0; index < leaves.length; index++) {
    const proof = await proofFor(leaves, index);
    assert.equal(await verifyInclusion(leaves[index], proof, tree.root), true,
      `the honest proof for leaf ${index} did not verify`);

    // Every truncation of it, and one step too many.
    for (let cut = 0; cut < proof.path.length; cut++) {
      assert.equal(
        await verifyInclusion(leaves[index], { ...proof, path: proof.path.slice(0, cut) }, tree.root),
        false, `a proof for leaf ${index} truncated to ${cut} of ${proof.path.length} steps was accepted`);
    }
    assert.equal(
      await verifyInclusion(leaves[index], { ...proof, path: [...proof.path, proof.path[0]] }, tree.root),
      false, `a proof for leaf ${index} with a spare step was accepted`);
  }
});

// ── receipt.mjs:329 and :334 — which reservations are still standing ────────

const stmt = (vendor, step, extra = {}) => ({
  statement: { vendor, step, origin: `https://${vendor}.example`, ...extra },
});
const PLAN = { parties: ['fly'], steps: ['fly.reserve', 'fly.confirm'] };

test('an unconfirmed reservation is not something standing; a confirmed one is', () => {
  // Three survivors lived in these two lines, and all three were about the
  // difference between a hold and a booking. A hold nobody confirmed expires by
  // itself and leaves the world as it was -- so a ledger with only a reserve in
  // it has come to nothing. A hold that was confirmed is a booking, and a
  // ledger that ends there has left something real behind.
  assert.equal(deriveOutcome(PLAN, [stmt('fly', 'reserve')]), 'unwound',
    'a reservation that was never confirmed was treated as still standing');

  assert.equal(deriveOutcome(PLAN, [stmt('fly', 'reserve'), stmt('fly', 'confirm')]), 'committed',
    'a confirmed reservation was not treated as a completed plan');

  // A confirmed booking with the plan unfinished is outstanding, not nothing.
  const bigger = { parties: ['fly', 'stay'], steps: ['fly.reserve', 'stay.execute', 'fly.confirm'] };
  assert.equal(deriveOutcome(bigger, [stmt('fly', 'reserve'), stmt('fly', 'confirm')]), 'in-doubt',
    'a confirmed booking inside an unfinished plan was reported as coming to nothing');

  // And a cancelled hold really is nothing.
  assert.equal(deriveOutcome(bigger, [stmt('fly', 'reserve'), stmt('fly', 'cancel')]), 'unwound');

  // An executed step with no reversal is standing whatever else is true.
  assert.equal(deriveOutcome(bigger, [stmt('stay', 'execute')]), 'in-doubt',
    'an unreversed execute was reported as coming to nothing');
});

// ── receipt.mjs:176 and :151 — the resolver, which no unit test could reach ─

test('the origin resolver refuses a key document that names a different party', async () => {
  // Two survivors here because nothing exercised fetchKeys: it is the one path
  // that needs the network, so it was the one path nobody checked. Stubbing
  // fetch is enough, and the defect it guards is the whole trust model --
  // an origin that hands back somebody else's key.
  const real = globalThis.fetch;
  const respond = (body, ok = true) => async () => ({ ok, json: async () => body });
  const doc = (vendor, keys) => ({ vendor, keys });
  const key = (keyId, extra = {}) => ({ keyId, kty: 'EC', crv: 'P-256', ...extra });

  try {
    globalThis.fetch = respond(doc('someone-else', [key('k1')]));
    await assert.rejects(
      () => originResolver()('fly', 'https://fly.example', 'k1'),
      /identifies itself as "someone-else"/,
      'a key document naming a different party was accepted');

    // The same document, honestly named, resolves.
    globalThis.fetch = respond(doc('fly', [key('k1')]));
    const found = await originResolver()('fly', 'https://fly.example', 'k1');
    assert.equal(found?.keyId, 'k1', 'a correctly named key document did not resolve');

    // An unknown keyId is absent rather than an error.
    globalThis.fetch = respond(doc('fly', [key('k1')]));
    assert.equal(await originResolver()('fly', 'https://fly.example', 'nope'), null);

    // A non-200 is not a key document, whatever the body says.
    globalThis.fetch = respond(doc('fly', [key('k1')]), false);
    await assert.rejects(
      () => originResolver()('fly', 'https://fly.example', 'k1'),
      /publishes no concord key document/,
      'a 404 that happened to carry a key-shaped body was accepted');

    // And a 200 that is not a key document at all.
    globalThis.fetch = respond({ hello: 'world' });
    await assert.rejects(
      () => originResolver()('fly', 'https://fly.example', 'k1'),
      /malformed key document/);
  } finally {
    globalThis.fetch = real;
  }
});

// ── receipt.mjs:496 — `if (record && !why)` ─────────────────────────────────

test('a key record with no usable material is a rejection, not a crash', async () => {
  // `why` is only ever set on a path where the resolver produced nothing, so
  // when it is set `record` is null anyway -- which is why `record || !why`
  // looks equivalent. It is not. The case it changes is a resolver that returns
  // something truthy that is not a key: the guard stops falling through, and
  // reading `.publicKey` off null throws out of verifyReceipt entirely.
  //
  // A verifier that crashes on a malformed key document is worse than one that
  // rejects, because the caller cannot tell a bad receipt from a broken tool.
  const { receipt } = await honestReceipt();

  const unusable = [
    { keyId: 'k1' },              // a record with no key material at all
    {},                           // an empty object
    { publicKey: null },          // the field, empty
    'not-an-object',
    42,
    [],
  ];

  for (const junk of unusable) {
    const out = await verifyReceipt(receipt, async () => junk);
    assert.equal(out.ok, false, `${JSON.stringify(junk)} was accepted as a key`);
    assert.ok(out.findings.every((f) => f.signed === false),
      `${JSON.stringify(junk)} was treated as having signed something`);
  }

  // And the honest resolver still verifies, so the loop above is measuring the
  // key material and not a receipt that was broken to begin with.
  const honest = await honestReceipt();
  assert.equal((await verifyReceipt(honest.receipt, honest.resolve)).ok, true);
});

// ── receipt.mjs:396 — which of two duplicate-statement complaints is raised ──

test('one key used twice is named for what it actually is', async () => {
  // Two statements under one idempotency key is malformed either way, so the
  // receipt is refused whichever branch runs and the mutant that swaps them
  // survives a test that only checks `ok === false`. The wording is the whole
  // value here: "the same statement twice" is a coordinator double-counting a
  // charge, and "two different statements" is a signer that answered twice
  // about one step. They are different incidents and lead to different
  // conversations, so the receipt has to say which one it found.
  const { receipt, resolve } = await honestReceipt();

  const twice = structuredClone(receipt);
  twice.entries.push(structuredClone(twice.entries[0]));
  const a = await verifyReceipt(twice, resolve);
  assert.equal(a.ok, false);
  assert.ok(a.complaints.some((c) => /the same statement appears twice/.test(c)),
    `an exact duplicate was reported as something else: ${JSON.stringify(a.complaints)}`);

  const disagreeing = structuredClone(receipt);
  disagreeing.entries[1].statement.idempotencyKey =
    disagreeing.entries[0].statement.idempotencyKey;
  const b = await verifyReceipt(disagreeing, resolve);
  assert.equal(b.ok, false);
  assert.ok(b.complaints.some((c) => /two different statements are signed under/.test(c)),
    `two different statements were reported as a duplicate: ${JSON.stringify(b.complaints)}`);
});
