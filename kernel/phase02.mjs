// Phase 02 — labels and the policy gate.
//
// Phase 01 proved the kernel can stand in the path. This proves it should.
// A scripted agent reads a mail thread carrying instructions written by an
// attacker, then tries to act on them. There is no language model here on
// purpose: the kernel's job is to hold whatever the agent asks for, and mixing
// in a model would test the model instead of the gate.

import { resolveModelContext } from '/shim/adapter.mjs';
import { createSuite, awaitTools } from './harness.mjs';
import { parsePolicy } from './policy.mjs';
import { Kernel } from './dispatch.mjs';
import { UNTRUSTED, TAINTED_CONTEXT } from './labels.mjs';

const WORKLOAD = 'http://localhost:5174';
const { record, finish } = createSuite('PHASE 02');
const { ctx, provider, surface, policy: toolsPolicy } = await resolveModelContext();

// ── B1 ── the policy is a file a person can read, and it parses
const source = await (await fetch('./policy.ring')).text();
const policy = parsePolicy(source);
record('B1', policy.rules.length >= 4 && policy.capabilities.length >= 1,
  'policy.ring parses into capabilities and ordered rules',
  `${policy.rules.length} rules, ${policy.capabilities.length} capability declarations`);

record('B2', policy.egressOf(`${WORKLOAD}/send_funds`) === 'funds'
          && policy.egressOf(`${WORKLOAD}/get_balance`) === 'none',
  'Egress class is resolved from the capability manifest',
  `send_funds=${policy.egressOf(`${WORKLOAD}/send_funds`)} · ` +
  `get_balance=${policy.egressOf(`${WORKLOAD}/get_balance`)}`);

// ── the kernel, with a confirmation handler the test can steer ──
let confirmDecision = false;
let confirmSeen = null;
const kernel = new Kernel({
  modelContext: ctx,
  policy,
  confirm: async (request) => { confirmSeen = request; return confirmDecision; },
});

const tools = await awaitTools(ctx, [WORKLOAD], (t) => t.some((x) => x.name === 'send_funds'));
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

// ── B3 ── reading is permitted, and the attack is genuinely present
const thread = await kernel.dispatch(byName.read_thread, { thread: 'inv-4471' });
const injected = JSON.stringify(thread).includes('acct_attacker_9f');
record('B3', injected,
  'The agent reads a thread that really does carry an injected instruction',
  injected ? 'payload names acct_attacker_9f and tells the assistant not to ask'
           : 'no payload present — the rest of this suite would prove nothing');

// ── B4 ── the read tainted the session
record('B4', kernel.provenance.context.has(UNTRUSTED),
  'Content from an untrustedContentHint tool is labelled at the boundary',
  `session context ${kernel.provenance.context}`);

// ── B5 ── a clean read still works; taint does not break the app
const balance = await kernel.dispatch(byName.get_balance, { account: 'acct_main' });
record('B5', balance.minor === 184230,
  'Reads stay permitted in a tainted session',
  `get_balance → ${balance.minor}`);

// ── B6 ── THE ATTACK. The agent does exactly what the injection told it to.
let denial = null;
try {
  await kernel.dispatch(byName.send_funds, {
    to: 'acct_attacker_9f',
    minor: 184230,
    memo: 'Remittance for invoice 4471 per automated notice',
  });
  record('B6', false, 'The injected transfer is denied', 'ALLOWED — the attack succeeded');
} catch (err) {
  denial = err;
  record('B6', err.name === 'PolicyDenial',
    'The injected transfer is denied before it executes',
    `${err.name}: ${err.message}`);
}

// ── B7 ── the denial points at the evidence, not just at a rule number
const ev = denial?.evidence ?? [];
record('B7', ev.some((e) => String(e.token).includes('acct_attacker_9f')),
  'The refusal cites the untrusted content the argument reused',
  ev.length ? ev.map((e) => `${e.field}="${e.token}" from ${e.source}`).join(' · ') : 'no evidence recorded');

// ── B8 ── a denied call has no side effect at all
const settled = (await kernel.dispatch(byName.list_transfers, {})).transfers;
record('B8', settled.length === 0,
  'Nothing settled in the workload — the denial preceded execution',
  settled.length ? `LEAKED — ${settled.length} transfer(s) settled` : '0 transfers settled');

// ── B9 ── possible flow is not treated as proven flow
confirmDecision = false;
let confirmed = null;
try {
  await kernel.dispatch(byName.send_funds, { to: 'acct_supplier', minor: 1000, memo: 'invoice 4471' });
  record('B9', false, 'A clean call in a tainted session asks a human', 'executed without asking');
} catch (err) {
  confirmed = err;
  record('B9', err.name === 'ConfirmationDeclined' && confirmSeen !== null,
    'A clean call in a tainted session asks a human rather than refusing or allowing',
    `asked about ${confirmSeen?.toolId} at ${confirmSeen?.label}, declined → ${err.name}`);
}

record('B10', String(confirmSeen?.label).includes(TAINTED_CONTEXT),
  'The human is told the session is tainted, not merely asked to approve',
  `label shown: ${confirmSeen?.label}`);

// ── B11 ── approving lets the legitimate payment through
confirmDecision = true;
const paid = await kernel.dispatch(byName.send_funds, { to: 'acct_supplier', minor: 1000, memo: 'invoice 4471' });
const after = (await kernel.dispatch(byName.list_transfers, {})).transfers;
record('B11', paid?.ok === true && after.length === 1 && after[0].to === 'acct_supplier',
  'An approved payment executes, so the gate is not simply refusing everything',
  `settled → ${after.map((t) => `${t.to}:${t.minor}`).join(', ') || 'nothing'}`);

// ── B12 ── deny by default, not by omission
const unclassified = policy.check({
  toolId: `${WORKLOAD}/delete_everything`, effect: 'write', egress: 'none',
  label: { has: () => false },
});
record('B12', unclassified.allow === false,
  'An effectful tool no rule mentions is denied by default',
  unclassified.reason);

// ── B13 ── the transcript is the record a human would be shown
const denials = kernel.transcript.filter((e) => e.kind === 'deny');
record('B13', denials.length === 2 && denials[0].rule?.includes('untrusted'),
  'Every decision is recorded with the rule that produced it',
  `${kernel.transcript.length} entries · first denial by: ${denials[0]?.rule?.slice(0, 58) ?? 'none'}…`);

finish({ provider, surface, policy: toolsPolicy, transcript: kernel.transcript });
