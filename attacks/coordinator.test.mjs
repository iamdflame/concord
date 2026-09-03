// The coordinator is the adversary, and it has everything except the keys.
//
// attacks/browser.mjs fires fourteen hand-written forgeries, each one a thing
// somebody thought of. This does something different and stronger: it gives the
// coordinator its full power and enumerates what it can build.
//
// A Concord coordinator runs in the page. It sees every statement, writes the
// receipt, chooses the tree, chooses the outcome field, and hands the result to
// the person who asked. The only thing it cannot do is produce a signature for
// a key it does not hold -- and the whole claim of this project rests on that
// one asymmetry being enough.
//
// So: every subset of the honest statements, every ordering that matters, every
// duplication, every value of the unsigned outcome field, and every splice from
// a second commitment. The tree is rebuilt each time, exactly as a coordinator
// would rebuild it, so nothing here fails merely because a root stopped
// matching. THE ASSERTION IS AN IFF:
//
//   a receipt verifies exactly when every party named in the plan has said
//   something, and the outcome field is the one those statements imply.
//
// Not "the forgeries I thought of are rejected". Every construction, judged
// against a rule rather than a list.
//
// Getting that rule right took two passes, and both corrections came from the
// sweep rather than from thinking harder.
//
// The first version asserted that only the complete four-statement ledger may
// verify. Three counterexamples: a receipt holding three of the four and saying
// "in-doubt" is the honest receipt of a commitment that reached the
// irreversible step and never confirmed, which is a thing that happens.
// Partiality is not the lie.
//
// The second version asserted only that the outcome field must match. Twelve
// counterexamples, all of the same shape: the verifier also refuses a receipt
// that omits a party entirely, however honestly it is then labelled. That is
// the point of every vendor signing the shape of the whole -- the survivors
// testify that somebody is missing. A vendor that genuinely did nothing says so
// and signs it; silence is a statement here, not an absence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyReceipt, deriveOutcome } from '../concord/receipt.mjs';
import { honestReceipt, rebuild } from './browser.mjs';

// `undefined` is deliberately absent from this list. rebuild() defaults the
// outcome to the original receipt's when it is not given, so passing undefined
// here quietly tested "committed" a second time rather than testing an absent
// field -- which made the sweep disagree with the verifier and the verifier
// right. An actually-missing outcome is tested on its own, below.
const OUTCOMES = ['committed', 'unwound', 'in-doubt', 'refused',
                  'Committed', 'COMMITTED', 'committed ', 'commited', '', null, 0, {}];

/** Every subset of xs, as arrays, smallest first. */
const subsets = (xs) => xs.reduce((acc, x) => [...acc, ...acc.map((s) => [...s, x])], [[]]);

test('of every receipt a malicious coordinator can build, only the true ones verify', async () => {
  const honest = await honestReceipt();
  const { receipt, resolve } = honest;
  const all = receipt.entries;
  const truth = deriveOutcome(all[0].statement.plan, all);

  /** Has every party the plan names said something -- even that it did nothing? */
  const everyPartyHeard = (entries) => {
    const heard = new Set(entries.map((e) => e.statement.vendor));
    return entries[0].statement.plan.parties.every((v) => heard.has(v));
  };

  let built = 0, accepted = 0;
  const wrongly = [];

  for (const subset of subsets(all)) {
    if (!subset.length) continue;            // a receipt with no entries is not a receipt
    for (const outcome of OUTCOMES) {
      // Rebuilt, not tampered: the root is correct for whatever is inside, so
      // every rejection below is about the content and never about the hash.
      const forged = await rebuild(receipt, subset, outcome);
      const out = await verifyReceipt(forged, resolve);
      built++;

      // What may pass: every party heard from, and an outcome field that agrees
      // with what those statements actually say.
      const shouldPass = everyPartyHeard(subset)
        && outcome === deriveOutcome(subset[0].statement.plan, subset);

      if (out.ok) accepted++;
      if (out.ok !== shouldPass) {
        wrongly.push({ kept: subset.map((e) => `${e.statement.vendor}.${e.statement.step}`),
                       outcome, verifierSaid: out.ok, shouldBe: shouldPass,
                       complaints: out.complaints?.slice(0, 1) });
      }
    }
  }

  assert.deepEqual(wrongly.slice(0, 3), [],
    `${wrongly.length} of ${built} constructions were judged wrongly`);
  // The sweep has to have accepted some and refused most, or "nothing verified"
  // would pass this test while meaning the verifier is broken.
  // One per subset that heard from everybody: the labelling that tells the
  // truth about it. Computed rather than hardcoded, so the count follows the
  // rule instead of the rule being fitted to a count.
  const complete = subsets(all).filter((sub) => sub.length && everyPartyHeard(sub));
  assert.ok(complete.length >= 3, `only ${complete.length} subsets heard from every party`);
  assert.equal(accepted, complete.length,
    `${complete.length} constructions should verify; ${accepted} of ${built} did`);
  assert.ok(built >= 180, `only ${built} constructions were tried`);
  // And the complete, honestly-labelled receipt is among them.
  assert.equal((await verifyReceipt(await rebuild(receipt, all, truth), resolve)).ok, true,
    'the true receipt did not verify');
});

test('a receipt with no outcome at all is refused, rather than silently derived', async () => {
  // A coordinator declining to say what happened is not neutrality. The
  // verifier could derive the answer -- it does anyway -- but a receipt that
  // makes no claim cannot be held to one, and "we never said it committed" is
  // exactly the defence this format exists to remove.
  const { receipt, resolve } = await honestReceipt();
  const silent = await rebuild(receipt, receipt.entries, receipt.outcome);
  delete silent.outcome;

  const out = await verifyReceipt(silent, resolve);
  assert.equal(out.ok, false, 'a receipt claiming nothing was accepted');
  assert.match(out.complaints[0], /is not an outcome; a receipt must claim one of/);
});

test('a coordinator cannot duplicate a statement to inflate what happened', async () => {
  const { receipt, resolve } = await honestReceipt();
  for (const entry of receipt.entries) {
    const doubled = await rebuild(receipt, [...receipt.entries, entry], receipt.outcome);
    const out = await verifyReceipt(doubled, resolve);
    assert.equal(out.ok, false,
      `${entry.statement.vendor}.${entry.statement.step} was accepted twice`);
  }
});

test('a coordinator cannot reorder statements into a different story', async () => {
  const { receipt, resolve } = await honestReceipt();
  const reversed = [...receipt.entries].reverse();
  const out = await verifyReceipt(await rebuild(receipt, reversed, receipt.outcome), resolve);
  // Order is not itself a lie -- the entries carry their own steps -- so this
  // may legitimately pass. What must not change is the *conclusion*.
  const before = deriveOutcome(receipt.entries[0].statement.plan, receipt.entries);
  const after = deriveOutcome(reversed[0].statement.plan, reversed);
  assert.equal(after, before, 'reordering the ledger changed what it says happened');
  assert.equal(out.ok, true, 'a correctly-signed complete ledger was rejected for its order');
});

test('a coordinator running two commitments cannot splice one into the other', async () => {
  // It holds both. Every statement in both is genuinely signed. The defence is
  // that each statement names the saga it belongs to, and every party signs the
  // shape of the whole -- so a statement from elsewhere is a statement about a
  // commitment these parties never agreed to.
  const a = await honestReceipt('saga_one');
  const b = await honestReceipt('saga_two');

  const resolveBoth = async (vendor, origin, keyId) => {
    for (const r of [a.resolve, b.resolve]) {
      const found = await r(vendor, origin, keyId).catch(() => null);
      if (found) return found;
    }
    return null;
  };

  for (const [i, stolen] of b.receipt.entries.entries()) {
    const spliced = await rebuild(a.receipt,
      [...a.receipt.entries.slice(0, -1), stolen], a.receipt.outcome);
    const out = await verifyReceipt(spliced, resolveBoth);
    assert.equal(out.ok, false, `statement ${i} from saga_two was accepted into saga_one`);
  }

  // The control: both receipts verify on their own under the combined
  // resolver, so the rejections above are about the splice and not about the
  // resolver failing to find keys.
  assert.equal((await verifyReceipt(a.receipt, resolveBoth)).ok, true);
  assert.equal((await verifyReceipt(b.receipt, resolveBoth)).ok, true);
});

test('a coordinator cannot point a statement at a key document it controls', async () => {
  // The last resort: keep every signature, and change where the verifier looks
  // for the key. The origin is inside the signed statement, so changing it
  // breaks the signature; and the resolver refuses a document from an origin
  // that names a different party even when it is asked nicely.
  const { receipt, resolve } = await honestReceipt();

  const copy = structuredClone(receipt);
  copy.entries[1].statement.origin = 'https://fly.example';
  assert.equal((await verifyReceipt(copy, resolve)).ok, false,
    'a statement was accepted after being pointed at another party\'s origin');

  const attacker = async (vendor, origin, keyId) => resolve('fly', 'https://fly.example', keyId);
  assert.equal((await verifyReceipt(receipt, attacker)).ok, false,
    'a resolver that returns one party\'s key for every party was not caught');
});
