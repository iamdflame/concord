// Concord — the coordinator.
//
// Everything on screen above the Commit button was derived from what the
// vendors said about themselves. The coordinator has no agreement with any of
// them, cannot see their code, and has not contacted them for anything except
// the question "what can you commit to". If the answer is that no honest
// promise exists, the button does not run.

import { resolveModelContext } from '/shim/adapter.mjs';
import { awaitTools } from './harness.mjs';
import { discover, bind, withInputs } from '/concord/client.mjs';
import { plan, describe, GUARANTEE, RUNG } from '/concord/ladder.mjs';
import { runSaga, OUTCOME } from '/concord/saga.mjs';
import { buildReceipt, verifyReceipt } from '/concord/receipt.mjs';

const FLY = 'http://localhost:5177', STAY = 'http://localhost:5178', VISA = 'http://localhost:5179';
const ALL = [FLY, STAY, VISA];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<&]/g, (c) => ({ '<': '&lt;', '&': '&amp;' }[c]));

const INPUTS = {
  fly:  { route: 'LOS-LHR', date: '2026-10-04' },
  stay: { nights: 3, city: 'London' },
  visa: { applicant: 'D. Flame', country: 'GB' },
};

// A second irreversible vendor, declared but never contacted. It exists so the
// refusal can be shown in one click: this is the case where the honest answer
// is that atomicity is not available at any price.
const PHANTOM = {
  id: 'permit', title: 'Entry Permit', origin: 'http://permit.example',
  protocol: { steps: { execute: { tool: 'pay_permit' } }, irreversible: true }, tools: {},
};

const SCENARIOS = [
  { key: 'trip',    label: 'Flight + hotel + visa', ids: ['fly', 'stay', 'visa'], extra: [] },
  { key: 'nofee',   label: 'Flight + hotel only',   ids: ['fly', 'stay'],         extra: [] },
  { key: 'hold',    label: 'Flight only',           ids: ['fly'],                 extra: [] },
  { key: 'refused', label: 'Two irreversible',      ids: ['fly', 'visa'],         extra: [PHANTOM] },
];

const { ctx } = await resolveModelContext();
await awaitTools(ctx, ALL, (t) =>
  ALL.every((o) => t.some((x) => x.origin === o && x.name === 'concord.protocol')));

let discovered = await discover(ctx, ALL);
let current = SCENARIOS[0];
let planned = null;
let running = false;

$('pcount').textContent = String(discovered.length);
$('sub').textContent = 'declarations read';

// ── the promise ─────────────────────────────────────────────────────────────
function participantsFor(scenario) {
  return withInputs(
    [...discovered.filter((p) => scenario.ids.includes(p.id)), ...scenario.extra],
    INPUTS);
}

function renderPlan() {
  const participants = participantsFor(current);
  planned = plan(participants);
  const byId = new Map(participants.map((p) => [p.id, p]));

  const refused = planned.guarantee === GUARANTEE.REFUSED;
  $('verdict').textContent = {
    [GUARANTEE.ATOMIC]: 'Fully atomic',
    [GUARANTEE.COMPENSATED]: 'Atomic by compensation',
    [GUARANTEE.BOUNDED]: 'Atomic up to a final commit',
    [GUARANTEE.REFUSED]: 'No honest promise available',
  }[planned.guarantee];
  $('verdict').className = `verdict ${planned.guarantee}`;
  // describe() opens with the same phrase as the headline; showing both reads
  // as a stutter, so the headline keeps it and the paragraph carries the rest.
  $('explain').textContent = refused ? planned.refusal : describe(planned).replace(/^[^.]+\.\s*/, '');

  const stepsOf = (p) => Object.entries(p.protocol.steps).map(([k, v]) => v.tool).join(' → ');
  $('ladder').innerHTML = planned.order.map((id, i) => {
    const rung = planned.rungs.find((r) => r.id === id);
    const p = byId.get(id);
    const ponr = planned.pointOfNoReturn === i;
    return `<div class="rung r${rung.rung}">
      <span class="n">${i + 1}</span>
      <span class="who">${esc(p.title)}</span>
      <span class="bar"><i></i></span>
      <span class="steps">${esc(stepsOf(p))}${ponr ? ' <span class="ponr">◀ POINT OF NO RETURN</span>' : ''}</span>
    </div>`;
  }).join('');

  $('caveats').innerHTML = planned.caveats.map((c) => `<div class="caveat"><b>!</b><span>${esc(c)}</span></div>`).join('');
  $('commit').disabled = refused || running;
  $('commit').textContent = refused ? 'Refused' : 'Commit';
}

$('scenarios').innerHTML = SCENARIOS.map((s) =>
  `<button data-key="${s.key}" aria-pressed="${s.key === current.key}">${esc(s.label)}</button>`).join('');
$('scenarios').addEventListener('click', (e) => {
  const key = e.target.closest('button')?.dataset.key;
  if (!key || running) return;
  current = SCENARIOS.find((s) => s.key === key);
  for (const b of $('scenarios').children) b.setAttribute('aria-pressed', String(b.dataset.key === key));
  $('run').innerHTML = '<p class="hint">Nothing has been contacted yet.</p>';
  $('outcome').innerHTML = '';
  renderPlan();
});

// ── execution ───────────────────────────────────────────────────────────────
const PHASE = {
  reserve: 'holding', reserved: 'holding',
  execute: 'committing what can be reversed', executed: 'committing what can be reversed',
  point_of_no_return: 'the irreversible step', committed: 'the irreversible step',
  confirm: 'confirming', confirm_retry: 'confirming', confirmed: 'confirming',
  unwind: 'unwinding', compensate: 'unwinding', cancel: 'unwinding',
  compensate_failed: 'unwinding', cancel_failed: 'unwinding',
};
const TONE = {
  reserved: 'hold', executed: 'hold', committed: 'bad', confirmed: 'ok',
  compensate: 'hold', cancel: 'ok', confirm_retry: 'bad',
  compensate_failed: 'bad', cancel_failed: 'bad', in_doubt: 'bad',
};

function line(e) {
  if (e.type === 'point_of_no_return') {
    return `<div class="ponr-mark">POINT OF NO RETURN — ${esc(e.note)}. Everything before this can still be undone.</div>`;
  }
  const detail = e.ref?.ref ?? e.ref ?? e.error ?? e.cause ?? e.note ?? '';
  return `<div class="ev ${TONE[e.type] ?? ''}"><b>${esc(e.type.replace(/_/g, ' '))}</b>` +
         `<span>${esc([e.id, detail].filter(Boolean).join(' · '))}</span></div>`;
}

async function commit() {
  running = true;
  $('commit').disabled = true;
  $('outcome').innerHTML = '';
  $('run').innerHTML = '';

  const participants = participantsFor(current);
  const call = bind(ctx, participants);
  let phase = null;

  const out = await runSaga({
    plan: planned,
    participants,
    call,
    retryDelayMs: 260,
    onEvent(e) {
      const group = PHASE[e.type];
      if (group && group !== phase) {
        phase = group;
        const tone = group === 'unwinding' ? 'warn' : group === 'the irreversible step' ? 'err' : 'on';
        $('run').insertAdjacentHTML('beforeend',
          `<div class="phase"><div class="phase-h"><i class="dot ${tone}"></i><span class="lbl">${group}</span></div></div>`);
      }
      if (['plan', 'done'].includes(e.type)) return;
      ($('run').lastElementChild ?? $('run')).insertAdjacentHTML('beforeend', line(e));
    },
  });

  const headline = {
    [OUTCOME.COMMITTED]: 'Committed across every vendor',
    [OUTCOME.UNWOUND]: 'Nothing stands — every reversible step was reversed',
    [OUTCOME.IN_DOUBT]: 'In doubt — some effects cannot be reversed',
    [OUTCOME.REFUSED]: 'Refused before contacting anyone',
  }[out.outcome];

  const body = out.outcome === OUTCOME.IN_DOUBT
    ? `<p>${out.stranded?.map(esc).join('<br>') ?? esc(out.cause)}</p>`
    : out.outcome === OUTCOME.UNWOUND
      ? `<p>${esc(out.cause)}. The vendors above show the reversals.</p>`
      : `<p>${esc(planned.order.join(', '))} — settled together.</p>`;

  $('outcome').innerHTML = `<div class="outcome ${out.outcome}"><b>${headline}</b>${body}` +
    `<code>${out.journal.length} protocol events · saga ${esc(out.journal[0]?.sagaId ?? '')}</code></div>`;

  // The receipt is built from statements the vendors signed, which the
  // coordinator only forwarded. It can order them and prove the ordering; it
  // cannot write one.
  if (call.attestations.length) {
    const receipt = await buildReceipt({
      sagaId: out.journal[0]?.sagaId, outcome: out.outcome,
      entries: call.attestations, keys: call.publicKeys,
    });
    await renderReceipt(receipt);
    globalThis.__CONCORD_RECEIPT__ = receipt;
  } else {
    $('receipt').innerHTML = '';
  }

  running = false;
  $('commit').disabled = false;
  globalThis.__CONCORD_LAST__ = out;
}

async function renderReceipt(receipt) {
  const v = await verifyReceipt(receipt);
  const rows = (v.findings[0]?.vendor ? v.findings : []).map((f) =>
    `<div class="rrow"><span class="v">${esc(f.vendor)}</span><span class="s">${esc(f.step)}</span>` +
    `<span class="s">in the tree <b class="chk${f.included ? '' : ' no'}">${f.included ? '✓' : '✗'}</b></span>` +
    `<span class="s">signed by ${esc(f.vendor)} <b class="chk${f.signed ? '' : ' no'}">${f.signed ? '✓' : '✗'}</b></span></div>`).join('');

  const broken = v.findings.find((f) => f.why);
  const names = [...new Set(receipt.entries.map((e) => e.statement.vendor))];
  const first = receipt.proofs[0]?.length ?? 0;

  $('receipt').innerHTML = `<div class="receipt">
    <div class="receipt-head">
      <span><span class="lbl">receipt root</span><br><span class="root">${esc(receipt.root)}</span></span>
      <span class="rstate ${v.ok ? 'ok' : 'bad'}">${v.ok ? 'VERIFIED' : 'FAILS VERIFICATION'}</span>
    </div>
    ${broken ? `<div class="rfoot" style="color:var(--bad)">${esc(broken.why)}</div>` : rows}
    <div class="rfoot">
      Each line is a statement its vendor signed with a key that never left its origin.
      ${names[0] ? `${esc(names[0])} verifies its own entries from ${first} opaque hashes,
      without being shown what the others charged.` : ''}
      <br><button id="tamper">Edit one entry and re-verify</button>
    </div>
  </div>`;

  $('tamper')?.addEventListener('click', async () => {
    const copy = structuredClone(receipt);
    // Exactly the edit a coordinator with a motive would make.
    const i = copy.entries.findIndex((e) => e.statement.result?.minor !== undefined);
    if (i >= 0) copy.entries[i].statement.result.minor = 1;
    else copy.entries[0].statement.step = 'nothing';
    await renderReceipt(copy);
  });
}

$('commit').addEventListener('click', commit);
$('reset').addEventListener('click', () => {
  for (const id of ['fly', 'stay', 'visa']) $(id).contentWindow.location.reload();
  $('run').innerHTML = '<p class="hint">Vendors reset. Nothing has been contacted.</p>';
  $('outcome').innerHTML = '';
  setTimeout(async () => { discovered = await discover(ctx, ALL); renderPlan(); }, 900);
});

renderPlan();
globalThis.__CONCORD_READY__ = true;
