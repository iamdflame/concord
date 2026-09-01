// Concord across three real origins, in a real browser, over real WebMCP.
//
// The pure-logic suites proved the protocol. This proves it survives contact
// with independent origins that were written separately, expose different
// tools, and can be broken while it is running.

import { resolveModelContext } from '/shim/adapter.mjs';
import { createSuite, awaitTools } from './harness.mjs';
import { discover, bind, withInputs } from '/concord/client.mjs';
import { plan, describe, GUARANTEE } from '/concord/ladder.mjs';
import { runSaga, OUTCOME } from '/concord/saga.mjs';
import { buildReceipt, verifyReceipt, verifyOwnEntry, leafHash } from '/concord/receipt.mjs';
import { Journal, MemoryStore } from '/concord/journal.mjs';
import { recover } from '/concord/recover.mjs';

const FLY = 'http://localhost:5177';
const STAY = 'http://localhost:5178';
const VISA = 'http://localhost:5179';
const ALL = [FLY, STAY, VISA];

const { record, finish } = createSuite('CONCORD');
const { ctx, provider } = await resolveModelContext();

await awaitTools(ctx, ALL, (t) =>
  ALL.every((o) => t.some((x) => x.origin === o && x.name === 'concord.protocol')));

const INPUTS = {
  fly:  { route: 'LOS-LHR', date: '2026-10-04' },
  stay: { nights: 3, city: 'London' },
  visa: { applicant: 'D. Flame', country: 'GB' },
};

/** A fresh set of participants, so each scenario starts from a clean read. */
const load = async (ids = ['fly', 'stay', 'visa']) => {
  const found = await discover(ctx, ALL);
  return withInputs(found.filter((p) => ids.includes(p.id)), INPUTS);
};

const breakStep = (frame, step, on) => {
  const box = document.getElementById(frame).contentWindow;
  // Cross-origin: we cannot reach in, so drive the vendor's own operator
  // control the way a person would — through the page.
  return new Promise((resolve) => {
    box.postMessage({ __concord_break__: { step, on } }, '*');
    setTimeout(resolve, 120);
  });
};

// ── C1 ── discovery without agreement
const participants = await load();
record('C1', participants.length === 3 && participants.every((p) => p.protocol?.steps),
  'Three vendors declare a commitment protocol, discovered with no prior agreement',
  participants.map((p) => `${p.id}:${Object.keys(p.protocol.steps).join('+')}`).join(' · '));

// ── C2 ── the guarantee is computed before anything is touched
const full = plan(participants);
record('C2', full.guarantee === GUARANTEE.BOUNDED && full.order.at(-1) === 'visa',
  'The plan orders the irreversible vendor last and says what it can promise',
  `${full.guarantee} · order ${full.order.join(' → ')}`);

record('C3', /cannot be reversed/.test(full.caveats.join(' ')) && /briefly real/.test(full.caveats.join(' ')),
  'The caveats name both the irreversible fee and the real-then-refunded charge',
  full.caveats.join(' | ').slice(0, 150));

// ── C4 ── the happy path, across three businesses
const events = [];
const call = bind(ctx, participants);
const ok = await runSaga({ plan: full, participants, call, onEvent: (e) => events.push(e) });
record('C4', ok.outcome === OUTCOME.COMMITTED,
  'A three-vendor commitment completes across independent origins',
  `${ok.outcome} · ${events.filter((e) => e.type === 'confirmed' || e.type === 'committed').length} committed`);

record('C5', events.findIndex((e) => e.type === 'point_of_no_return')
           < events.findIndex((e) => e.type === 'confirmed'),
  'Confirm really does run after the point of no return, against live vendors',
  events.filter((e) => ['reserved', 'executed', 'point_of_no_return', 'confirmed'].includes(e.type))
        .map((e) => e.type).join(' → '));

// ── C6 ── break the irreversible vendor and watch everything reverse
await breakStep('visa', 'execute', true);
const p2 = await load();
const events2 = [];
const unwound = await runSaga({
  plan: plan(p2), participants: p2, call: bind(ctx, p2), onEvent: (e) => events2.push(e),
});
await breakStep('visa', 'execute', false);

record('C6', unwound.outcome === OUTCOME.UNWOUND,
  'Breaking the irreversible vendor unwinds every reversible step that ran',
  `${unwound.outcome} · ${events2.filter((e) => e.type === 'compensate' || e.type === 'cancel').length} reversals`);

record('C7', events2.some((e) => e.type === 'compensate') && events2.some((e) => e.type === 'cancel'),
  'The hotel is refunded and the seat is released — both kinds of reversal, in order',
  events2.filter((e) => ['compensate', 'cancel'].includes(e.type)).map((e) => `${e.type} ${e.id}`).join(' → '));

// ── C8 ── the ladder refuses rather than pretending
const twoIrreversible = [
  ...(await load(['visa'])),
  { id: 'permit', title: 'Permit', protocol: { steps: { execute: { tool: 'x' } } }, tools: {} },
];
const refused = plan(twoIrreversible);
const nothingRan = await runSaga({ plan: refused, participants: twoIrreversible, call: async () => {
  throw new Error('a refused plan must not contact a vendor');
} });
record('C8', refused.guarantee === GUARANTEE.REFUSED && nothingRan.outcome === OUTCOME.REFUSED,
  'Two irreversible vendors are refused, and nothing is contacted',
  refused.refusal.slice(0, 130));

// ── C9 ── idempotency is enforced by the vendor, not assumed by us
const p3 = await load(['fly']);
const soloCall = bind(ctx, p3);
const first = await soloCall('fly', 'hold_seat', INPUTS.fly, { idempotencyKey: 'dup-key-1', sagaId: 'dup' });
const again = await soloCall('fly', 'hold_seat', INPUTS.fly, { idempotencyKey: 'dup-key-1', sagaId: 'dup' });
record('C9', first.ref === again.ref && again.replayed === true,
  'A repeated idempotency key returns the first answer instead of doing the work twice',
  `${first.ref} then ${again.ref} (replayed=${again.replayed})`);

record('C10', describe(full).startsWith('Atomic up to a final commit'),
  'The guarantee is stated in a sentence a person can act on before committing',
  describe(full));

// ── C11-C15 ── the receipt
record('C11', Object.keys(call.vendors).length === 3,
  'Every vendor declares where its signing key is published, rather than handing one over',
  Object.entries(call.vendors).map(([k, v]) => `${k} → ${v.origin}/.well-known · ${v.keyId}`).join(' · '));

const receipt = await buildReceipt({
  sagaId: ok.journal[0].sagaId, outcome: ok.outcome,
  entries: call.attestations, vendors: call.vendors,
});
const verified = await verifyReceipt(receipt);
record('C12', verified.ok && receipt.entries.length === call.attestations.length,
  'The receipt verifies: every statement signed by the vendor that made it',
  `root ${receipt.root.slice(0, 16)}… · ${verified.findings.length} entries all signed and included`);

// A vendor holds only its own entry, its proof, and the root.
const mine = receipt.entries.findIndex((e) => e.statement.vendor === 'fly');
const flyKeys = await (await fetch(`${call.vendors.fly.origin}/.well-known/concord.json`)).json();
const own = await verifyOwnEntry({
  entry: receipt.entries[mine], proof: receipt.proofs[mine], root: receipt.root,
  jwk: flyKeys.keys.find((k) => k.keyId === receipt.entries[mine].keyId).publicKey,
});
const leaked = JSON.stringify(receipt.proofs[mine]);
record('C13', own.ok && !/minor|ref|RH|CF/.test(leaked),
  'A vendor verifies its own entry without being shown what the others charged',
  `included=${own.included} signed=${own.signed} · proof is ${receipt.proofs[mine].length} opaque hashes`);

// The coordinator has every reason to misreport and no way to.
const forged = structuredClone(receipt);
forged.entries[mine].statement.result = { ...forged.entries[mine].statement.result, minor: 1 };
const caught = await verifyReceipt(forged);
record('C14', caught.ok === false,
  'Editing a vendor\'s statement in the receipt is caught',
  caught.findings[0]?.why ?? 'root mismatch');

const reforged = structuredClone(receipt);
const other = receipt.entries.findIndex((e) => e.statement.vendor !== 'fly');
reforged.entries[mine].signature = reforged.entries[other].signature;
const caught2 = await verifyReceipt(reforged);
globalThis.__CONCORD_RECEIPT__ = receipt;
record('C15', caught2.ok === false && caught2.findings.some((f) => f.included && !f.signed),
  'A statement carrying someone else\'s signature is in the tree but unsigned',
  caught2.findings.filter((f) => !f.signed).map((f) => `${f.vendor}.${f.step} unsigned`).join(', '));

// ── C16-C18 ── the coordinator dies mid-commitment
// The case that costs real money: the hotel has been charged and the process
// stops before the reply is recorded, so only the hotel knows it happened.
const crashParticipants = await load(['fly', 'stay', 'visa']);
const crashJournal = new Journal(new MemoryStore());
const liveCall = bind(ctx, crashParticipants);
let calls = 0;
const dyingCall = async (...args) => {
  const out = await liveCall(...args);
  if (++calls >= 2) { const e = new Error('the coordinator stopped'); e.fatal = true; throw e; }
  return out;
};

let died = false;
try {
  await runSaga({ plan: plan(crashParticipants), participants: crashParticipants,
    call: dyingCall, journal: crashJournal });
} catch (err) { died = err.fatal === true; }

const outstanding = await crashJournal.incomplete();
record('C16', died && outstanding.length === 1 && outstanding[0].uncertain.length === 1,
  'A dead coordinator unwinds nothing and leaves the interrupted step unresolved',
  `${outstanding[0]?.completed.length ?? 0} done · ${outstanding[0]?.uncertain.length ?? 0} uncertain ` +
  `(${outstanding[0]?.uncertain[0]?.vendor}.${outstanding[0]?.uncertain[0]?.step})`);

const before = (await bind(ctx, crashParticipants)('stay', 'list_transfers', {}, {}).catch(() => null));
const [report] = await recover({
  journal: crashJournal, participants: crashParticipants, call: bind(ctx, crashParticipants),
});
record('C17', report?.outcome === 'unwound' && report.reversals.length === 2,
  'Probing each vendor finds the charge only the vendor knew about, and reverses it',
  report?.reversals.map((r) => `${r.vendor}.${r.step} ${r.reversed ? `via ${r.via}` : 'NOT UNDONE'}`).join(' · '));

record('C18', (await crashJournal.incomplete()).length === 0,
  'The recovered commitment is settled, so it is not resolved twice',
  `${(await crashJournal.incomplete()).length} outstanding after recovery`);

finish({ provider, guarantee: full.guarantee, receiptRoot: receipt.root });
