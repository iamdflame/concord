// Concord — the coordinator.
//
// Everything on screen above the Commit button was derived from what the
// vendors said about themselves. The coordinator has no agreement with any of
// them, cannot see their code, and has not contacted them for anything except
// the question "what can you commit to". If the answer is that no honest
// promise exists, the button does not run.

import { resolveModelContext } from '/shim/adapter.mjs';
import { awaitTools } from '/kit/harness.mjs';
import { discover, bind, withInputs } from '/concord/client.mjs';
import { plan, describe, GUARANTEE, RUNG } from '/concord/ladder.mjs';
import { runSaga, OUTCOME } from '/concord/saga.mjs';
import { buildReceipt, verifyReceipt } from '/concord/receipt.mjs';
import { Journal, IndexedStore, LocalStore } from '/concord/journal.mjs';
import { recover } from '/concord/recover.mjs';
import { publishAgentTools } from './agent-tools.mjs';
import { ORIGINS, VENDORS, VENDOR_ORIGINS, TITLES } from '/config.mjs';
import { makeReader, turn } from './agent.mjs';

const ALL = VENDOR_ORIGINS;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&"']/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

const INPUTS = {
  fly:  { route: 'LOS-LHR', date: '2026-10-04' },
  stay: { nights: 3, city: 'London' },
  visa: { applicant: 'D. Flame', country: 'GB' },
  permit: { applicant: 'D. Flame', country: 'GB' },
  shady:  { nights: 3, city: 'London' },
};

// A second irreversible vendor, declared but never contacted. It exists so the
// refusal can be shown in one click: this is the case where the honest answer
// is that atomicity is not available at any price.
const PHANTOM = {
  id: 'permit', title: 'Entry Permit', origin: 'http://permit.example',
  protocol: { steps: { execute: { tool: 'pay_permit' } }, irreversible: true }, tools: {},
};

const PROMPTS = [
  'Book me London for three nights — flight, hotel and the visa fee.',
  'A flight and a hotel, nothing I cannot take back.',
  'Just hold me a seat.',
  'Flight, visa fee and the entry permit.',
  'A flight and an allocation with Meridian Holdings.',
];

/**
 * Say what went wrong, on the page.
 *
 * This module is top-level await, so anything thrown while it boots -- a vendor
 * that will not load, one returning malformed JSON, discovery timing out --
 * used to leave a completely blank screen with the reason only in the console.
 * A blank page is the worst thing a first-time visitor can be handed, and it is
 * the failure mode most likely to happen on someone else's machine.
 */
function fatal(err, context) {
  const wrap = document.querySelector('.wrap');
  const detail = String(err?.message ?? err);
  if (wrap) {
    wrap.innerHTML = `<div class="col" style="grid-column:1/-1">
      <div class="promise"><div class="promise-head">
        <span class="lbl">this coordinator could not start</span>
        <div class="verdict refused">${esc(context)}</div>
        <p>${esc(detail)}</p>
      </div><div class="caveats">
        <div class="caveat"><b>!</b><span>Concord needs its four vendor origins running.
          Start them with <code>npm run dev</code> and reload — they are separate origins on
          ${esc(VENDOR_ORIGINS.join(', '))}, and the coordinator deliberately cannot proceed
          without hearing from all of them.</span></div>
        <div class="caveat"><b>!</b><span>Nothing was contacted and nothing is outstanding.
          A commitment that cannot be planned is never started.</span></div>
      </div></div>
      <div class="actions"><button onclick="location.reload()">Try again</button></div>
    </div>`;
  }
  document.getElementById('sub').textContent = 'failed to start';
  globalThis.__CONCORD_ERROR__ = detail;
  console.error(context, err);
}

addEventListener('unhandledrejection', (e) => {
  if (!globalThis.__CONCORD_READY__) fatal(e.reason, 'Something failed while starting up');
});

// Embed the participants before asking who is there. Discovery walks the frame
// tree, so a frame created after it has already run is a frame nobody sees --
// which is a coordinator that reports its own vendors unreachable.
for (const id of VENDORS) {
  const frame = document.createElement('iframe');
  frame.id = id;
  frame.src = `${ORIGINS[id]}/`;
  frame.allow = 'tools';
  frame.title = TITLES[id];
  frame.loading = 'eager';
  $('frames').append(frame);
}

let ctx;
try {
  ({ ctx } = await resolveModelContext());
  await awaitTools(ctx, ALL, (t) =>
    ALL.every((o) => t.some((x) => x.origin === o && x.name === 'concord.protocol')));
} catch (err) {
  fatal(err, 'The vendors could not be reached');
  throw err;
}

// Intent is written here before every call, and it survives the tab. Without
// it a coordinator that dies mid-commitment leaves real holds and real charges
// with nothing anywhere that knows to undo them.
const journal = new Journal(
  typeof indexedDB !== 'undefined' ? new IndexedStore() : new LocalStore());

// Settled commitments are history, not state. Left forever they eventually fill
// the quota, and the write that fails is the one meant to make a saga
// recoverable. Pruning is best-effort and never blocks a commitment.
journal.prune().catch(() => {});

let discovered;
try {
  discovered = await discover(ctx, ALL);
  if (discovered.length < ALL.length) {
    throw new Error(`only ${discovered.length} of ${ALL.length} vendors declared a commitment protocol`);
  }
} catch (err) {
  fatal(err, 'A vendor would not say what it can commit to');
  throw err;
}
let running = false;
let surfaceEventSink = () => {};

// The four tools an agent may reach, registered over WebMCP. The in-page agent
// below drives these; so can ChatGPT's, through the same registration.
await publishAgentTools({
  ctx,
  participants: withInputs(discovered, INPUTS),
  inputs: INPUTS,
  journal,
  bind: (participants) => {
    const call = bind(ctx, participants);
    return crashAfter ? killAfter(call, crashAfter) : call;
  },
  onEvent: (e) => surfaceEventSink(e),
});

$('pcount').textContent = String(discovered.length);
$('sub').textContent = 'declarations read';

// ── the promise, as the agent was told it ─────────────────────────────────
let proposal = null;      // what the agent last proposed, awaiting a decision

function showPromise(promise) {
  proposal = promise;
  const box = $('promiseBox');
  const refused = !promise?.committable;
  box.hidden = false;

  $('verdict').textContent = {
    atomic: 'All-or-nothing up to the final confirm',
    compensated: 'Atomic by compensation',
    bounded: 'Atomic up to a final commit',
    refused: 'No honest promise available',
  }[promise.guarantee] ?? promise.guarantee;
  $('verdict').className = `verdict ${promise.guarantee}`;
  $('explain').textContent = promise.summary;

  const byId = new Map(discovered.map((p) => [p.id, p]));
  $('ladder').innerHTML = promise.order.map((id, i) => {
    const p = byId.get(id);
    const steps = Object.values(p?.protocol?.steps ?? {}).map((v) => v.tool)
      .filter((t) => t !== 'concord.status').join(' → ');
    const rung = p?.protocol?.steps?.reserve ? 3 : p?.protocol?.steps?.compensate ? 2 : 1;
    return `<div class="rung r${rung}">
      <span class="n">${i + 1}</span>
      <span class="who">${esc(p?.title ?? id)}</span>
      <span class="bar"><i></i></span>
      <span class="steps">${esc(steps)}${promise.pointOfNoReturn === id
        ? ' <span class="ponr">◀ POINT OF NO RETURN</span>' : ''}</span>
    </div>`;
  }).join('');

  $('caveats').innerHTML = (promise.caveats ?? [])
    .map((c) => `<div class="caveat"><b>!</b><span>${esc(c)}</span></div>`).join('');

  // The gate. There is no way to commit anything the agent has not been given
  // permission for, and none at all for something the ladder refused.
  $('commit').hidden = refused;
  $('crash').hidden = refused;
  $('commit').disabled = false;
}

function clearPromise() {
  proposal = null;
  $('promiseBox').hidden = true;
  $('commit').hidden = true;
  $('crash').hidden = true;
}

// ── the conversation ──────────────────────────────────────────────────────
const reader = await makeReader();
$('brain').textContent = reader.kind;

function say(who, text, extra = {}) {
  $('transcript').insertAdjacentHTML('beforeend',
    `<div class="msg ${who}"><div class="who">${who === 'you' ? 'you' : 'agent'}</div>` +
    `<p>${esc(text)}</p>${extra.calls ?? ''}</div>`);
  $('transcript').scrollTop = $('transcript').scrollHeight;
}

/** Every tool the agent touches is shown, including the ones that refuse it. */
function noteCall(name, refused) {
  const last = $('transcript').lastElementChild;
  if (!last) return;
  let strip = last.querySelector('.calls');
  if (!strip) { last.insertAdjacentHTML('beforeend', '<div class="calls"></div>'); strip = last.querySelector('.calls'); }
  const cls = refused ? 'no' : name === 'concord_commit' ? 'eff' : '';
  strip.insertAdjacentHTML('beforeend', `<span class="call ${cls}">${esc(name)}${refused ? ' · refused' : ''}</span>`);
}

let awaitingGo = null;

async function callTool(name, args) {
  const tool = (await ctx.getTools()).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not published`);
  const raw = await ctx.executeTool(tool, JSON.stringify(args));
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const value = parsed?.structuredContent ?? parsed;
  noteCall(name, Boolean(value?.refused));
  return value;
}

async function ask(text) {
  say('you', text);
  clearPromise();
  $('run').innerHTML = '';
  $('outcome').innerHTML = '';
  $('receipt').innerHTML = '';

  try {
    const out = await turn({
      text, reader, tool: callTool, say,
      confirm: (promise) => new Promise((resolve) => {
        showPromise(promise);
        awaitingGo = resolve;
        say('agent', 'Say go ahead and I will do it. Nothing has been contacted yet.');
      }),
    });
    if (out) await reportOutcome(out);
    else { clearPromise(); running = false; }
  } catch (err) {
    say('agent', `I could not finish that: ${err.message}`);
  }
  awaitingGo = null;
}

$('prompts').innerHTML = PROMPTS.map((p) => `<button type="button">${esc(p)}</button>`).join('');
$('prompts').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) { $('q').value = b.textContent; $('q').focus(); }
});
$('ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('q').value.trim();
  if (!text || awaitingGo) return;
  $('q').value = '';
  ask(text);
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

let crashAfter = null;

/** Stops the coordinator dead after n calls, the way a closed tab would. */
function killAfter(call, n) {
  let seen = 0;
  const wrapped = async (...args) => {
    const result = await call(...args);
    // Status probes are not steps; counting them would kill it in the wrong place.
    if (args[3]?.step !== 'status' && ++seen >= n) {
      const e = new Error('the coordinator stopped');
      e.fatal = true;
      throw e;
    }
    return result;
  };
  // The receipt is assembled from what the underlying call collected, so those
  // have to survive the wrapper.
  wrapped.attestations = call.attestations;
  wrapped.vendors = call.vendors;
  return wrapped;
}

async function showPending() {
  const outstanding = await journal.incomplete();
  if (!outstanding.length) { $('pending').innerHTML = ''; return; }

  const s = outstanding[0];
  const lines = [...s.completed, ...s.uncertain].map((x) =>
    `<li>${esc(x.vendor)} · ${esc(x.step)} — ${x.done ? 'happened' : 'unknown; only the vendor knows'}</li>`);
  $('pending').innerHTML = `<div class="pending">
    <b>An interrupted commitment was found</b>
    <p>The coordinator stopped part-way through <code>${esc(s.sagaId)}</code>. These steps are
    outstanding, and something real may be held or charged right now:</p>
    <ul>${lines.join('')}</ul>
    <button id="resolve">Ask each vendor what happened, then resolve it</button>
  </div>`;

  $('resolve').addEventListener('click', async () => {
    $('resolve').disabled = true;
    // Rebuilt from every vendor present, never from whatever is on screen: a
    // recovery scoped to the current selection blamed an absent vendor for
    // being unaskable and stranded its charge.
    const all = withInputs(discovered, INPUTS);
    const reports = await recover({ journal, participants: all, call: bind(ctx, all) });
    const r = reports[0];
    $('pending').innerHTML = `<div class="pending" style="border-color:var(--ok)">
      <b style="color:var(--ok)">Resolved — ${esc(r?.outcome ?? 'nothing outstanding')}</b>
      <p>${r ? r.reversals.map((x) => `${esc(x.vendor)}.${esc(x.step)} ${x.reversed
        ? `undone via ${esc(x.via)}` : `NOT undone — ${esc(x.why)}`}`).join('<br>') : ''}</p>
      ${r?.unresolved.length ? `<p style="color:var(--bad)">${r.unresolved.map((u) => esc(u.why)).join('<br>')}</p>` : ''}
    </div>`;
  });
}

async function commit() {
  running = true;
  $('commit').disabled = true;
  $('crash').disabled = true;
  $('outcome').innerHTML = '';
  $('run').innerHTML = '';

  let phase = null;
  const onEvent = (e) => {
    const group = PHASE[e.type];
    if (group && group !== phase) {
      phase = group;
      const tone = group === 'unwinding' ? 'warn' : group === 'the irreversible step' ? 'err' : 'on';
      $('run').insertAdjacentHTML('beforeend',
        `<div class="phase"><div class="phase-h"><i class="dot ${tone}"></i><span class="lbl">${group}</span></div></div>`);
    }
    if (['plan', 'done', 'proposed', 'explained'].includes(e.type)) return;
    ($('run').lastElementChild ?? $('run')).insertAdjacentHTML('beforeend', line(e));
  };
  surfaceEventSink = onEvent;

  // Release the agent's turn: it is waiting on the human, and it is the agent
  // that calls concord_commit -- not this button. The button is consent.
  const go = awaitingGo;
  awaitingGo = null;
  if (go) go(true);

  await new Promise((r) => setTimeout(r, 60));
}

/** Draw the outcome and receipt once the agent's commit returns. */
async function reportOutcome(out) {
  const headline = {
    [OUTCOME.COMMITTED]: 'Committed across every vendor',
    [OUTCOME.UNWOUND]: 'Nothing stands — every reversible step was reversed',
    [OUTCOME.IN_DOUBT]: 'In doubt — some effects cannot be reversed',
    [OUTCOME.REFUSED]: 'Refused before contacting anyone',
  }[out.outcome];

  const body = out.outcome === OUTCOME.IN_DOUBT
    ? `<p>${out.stranded?.map(esc).join('<br>') ?? esc(out.cause ?? '')}</p>`
    : out.outcome === OUTCOME.UNWOUND
      ? `<p>${esc(out.cause ?? '')}. The vendors above show the reversals.</p>`
      : `<p>${esc((out.stands ?? []).map((id) => TITLES[id] ?? id).join(', '))} — settled together.</p>`;

  $('outcome').innerHTML = `<div class="outcome ${out.outcome}"><b>${headline}</b>${body}` +
    (out.unrecorded ? `<p style="color:var(--hold)">${esc(out.unrecorded)}</p>` : '') +
    `<code>${(out.journal ?? []).length} protocol events</code></div>`;

  if (out.attestations?.length) {
    const receipt = await buildReceipt({
      sagaId: out.journal?.[0]?.sagaId, outcome: out.outcome,
      entries: out.attestations, vendors: out.vendors,
    });
    await renderReceipt(receipt);
    globalThis.__CONCORD_RECEIPT__ = receipt;
  }

  running = false;
  $('commit').hidden = true;
  $('crash').hidden = true;
  $('crash').disabled = false;
  crashAfter = null;
  await showPending();
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
      <button id="export">Download receipt</button>
    </div>
  </div>`;

  $('export')?.addEventListener('click', () => {
    // The receipt has to be able to leave this tab, or the vendor is still
    // taking the coordinator's word for it. tools/verify-receipt.mjs checks
    // this file with nothing from us but the file itself.
    const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `receipt-${receipt.sagaId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

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
$('crash').addEventListener('click', async () => {
  // Two calls in, the hotel has been charged and the coordinator vanishes.
  crashAfter = 2;
  await commit();
  $('run').insertAdjacentHTML('beforeend',
    '<div class="ponr-mark">THE COORDINATOR STOPPED HERE. Nothing unwound, because nothing was ' +
    'left running to unwind it — reload the page and it will be found.</div>');
});
$('reset').addEventListener('click', () => {
  for (const id of ['fly', 'stay', 'visa']) $(id).contentWindow.location.reload();
  $('run').innerHTML = '<p class="hint">Vendors reset. Nothing has been contacted.</p>';
  $('outcome').innerHTML = '';
  setTimeout(async () => { discovered = await discover(ctx, ALL); clearPromise(); }, 900);
});

try {
  await showPending();
} catch (err) {
  // plan() refuses rather than throws for an unpromisable set, so reaching here
  // means something structural -- a participant with no protocol at all.
  fatal(err, 'This commitment could not be planned');
  throw err;
}
globalThis.__CONCORD_READY__ = true;
