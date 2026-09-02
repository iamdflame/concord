// Phase 04 — the transcript, and what makes replay honest.
//
// The interface built on this lets you drag a timeline and watch the system as
// it stood at that instant. There are two ways to build that. One stores a
// snapshot per step and plays them back, which is a recording: it agrees with
// itself by construction and would keep agreeing after the logic changed
// underneath it. The other stores only what crossed the boundary and derives
// the rest on demand, which can be wrong -- and therefore can be checked.
//
// This suite checks it. Replaying to step n must reproduce exactly the labels
// the live kernel held at step n, for every n.

import { resolveModelContext } from '/shim/adapter.mjs';
import { createSuite, awaitTools } from '/kit/harness.mjs';
import { parsePolicy } from './policy.mjs';
import { Kernel } from './dispatch.mjs';
import { reconstruct } from './transcript.mjs';
import { MAIL, LEDGER, PAY, ALL } from './processes.mjs';

const { record, finish } = createSuite('PHASE 04');
const { ctx, provider, surface, policy: toolsPolicy } = await resolveModelContext();
const policy = parsePolicy(await (await fetch('./policy.ring')).text());

const kernel = new Kernel({ modelContext: ctx, policy, confirm: async () => true });

const NEEDED = ['read_thread', 'get_balance', 'list_invoices', 'send_funds', 'list_transfers'];
const tools = await awaitTools(ctx, ALL, (t) => NEEDED.every((n) => t.some((x) => x.name === n)));
const pick = (origin, name) => tools.find((t) => t.origin === origin && t.name === name);

// The same session as Phase 03, so the transcript under test is a real one.
const invoice = (await kernel.dispatch(pick(LEDGER, 'list_invoices'), { status: 'open' })).invoices[0];
await kernel.dispatch(pick(MAIL, 'read_thread'), { thread: invoice.id });
await kernel.dispatch(pick(LEDGER, 'get_balance'), { account: 'acct_main' });
try {
  await kernel.dispatch(pick(PAY, 'send_funds'), { to: 'acct_attacker_9f', minor: invoice.minor, memo: 'per notice' });
} catch { /* the denial is the point; it is in the transcript */ }
await kernel.dispatch(pick(PAY, 'send_funds'), { to: 'acct_supplier', minor: invoice.minor, memo: `Settlement ${invoice.id}` });

const entries = kernel.transcript.entries;

// ── D1 ── the chain holds
const verified = await kernel.transcript.verify();
record('D1', verified.ok && entries.length === 5,
  'The transcript is hash-chained and every link verifies',
  `${entries.length} entries · head ${entries.at(-1)?.hash} · ${verified.ok ? 'intact' : `broken at ${verified.brokenAt}`}`);

// ── D2 ── and it notices being edited
const original = entries[3].args.to;
entries[3].args.to = 'acct_somewhere_else';
const tampered = await kernel.transcript.verify();
entries[3].args.to = original;
const repaired = await kernel.transcript.verify();
record('D2', tampered.ok === false && tampered.brokenAt === 3 && repaired.ok,
  'Editing a recorded call breaks the chain at that entry',
  `tamper → broken at ${tampered.brokenAt} (${tampered.why}) · restored → ${repaired.ok ? 'intact' : 'still broken'}`);

// ── D3 ── THE CLAIM. Replay reproduces what actually held, at every step.
const mismatches = [];
for (let i = 0; i < entries.length; i++) {
  const derived = reconstruct(entries, i).context.tags.join(',');
  const lived = [...(entries[i].contextAfter ?? [])].sort().join(',');
  if (derived !== lived) mismatches.push(`step ${i}: replay ${derived || '{}'} ≠ live ${lived || '{}'}`);
}
record('D3', mismatches.length === 0,
  'Replaying to step n reproduces the labels the live kernel held at step n',
  mismatches.length ? mismatches[0] : `all ${entries.length} steps agree`);

// ── D4 ── reconstruction is a pure function of the log
const a = reconstruct(entries, 2);
const b = reconstruct(entries, 2);
record('D4', a.context.tags.join() === b.context.tags.join()
          && a.settled.length === b.settled.length && a !== b,
  'Reconstruction is pure — the same index always yields the same state',
  `context ${a.context} · settled ${a.settled.length}`);

// ── D5 ── the past really is different from the present
const beforeAttack = reconstruct(entries, 2);
const afterAttack = reconstruct(entries, 3);
record('D5', beforeAttack.denials.length === 0 && afterAttack.denials.length === 1,
  'Scrubbing before the denial shows a system that has not been attacked yet',
  `step 2 → ${beforeAttack.denials.length} denials · step 3 → ${afterAttack.denials.length}`);

// ── D6 ── taint appears at the step that caused it, not before
const beforeMail = reconstruct(entries, 0);
const afterMail = reconstruct(entries, 1);
record('D6', !beforeMail.context.has('UNTRUSTED') && afterMail.context.has('UNTRUSTED')
          && afterMail.origins.get(MAIL)?.tainted === true,
  'Taint enters the reconstruction exactly at the step that introduced it',
  `after ledger ${beforeMail.context} → after mail ${afterMail.context}`);

// ── D7 ── replay does not re-execute anything
// A reconstruction that re-ran the log would move money a second time. This is
// the assertion that separates deriving state from replaying effects.
const beforeReplay = (await kernel.dispatch(pick(PAY, 'list_transfers'), {})).transfers.length;
for (let i = 0; i < entries.length; i++) reconstruct(entries, i);
const afterReplay = (await kernel.dispatch(pick(PAY, 'list_transfers'), {})).transfers.length;
record('D7', beforeReplay === afterReplay && beforeReplay === 1,
  'Replaying the whole transcript settles nothing — it derives state, it does not re-run it',
  `transfers on the payments origin: ${beforeReplay} before replay, ${afterReplay} after`);

// ── D8 ── the final reconstruction agrees with the live kernel
const final = reconstruct(entries, entries.length - 1);
record('D8', final.context.tags.join() === kernel.provenance.context.tags.join(),
  'Reconstructing the whole log lands on the live kernel state',
  `replay ${final.context} · live ${kernel.provenance.context}`);

record('D9', final.origins.size === 3 && final.settled.length === 1 && final.denials.length === 1,
  'The reconstruction accounts for all three origins, one settlement, one denial',
  `${final.origins.size} origins · ${final.settled.length} settled · ${final.denials.length} denied`);

finish({ provider, surface, policy: toolsPolicy, transcript: entries });
