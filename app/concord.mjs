// Concord — the coordinator.
//
// Everything on screen above the Go ahead button was derived from what the
// vendors said about themselves. The coordinator has no agreement with any of
// them, cannot see their code, and has not contacted them for anything except
// the question "what can you commit to". If the answer is that no honest
// promise exists, the button is not on the page.

import { resolveModelContext } from '/shim/adapter.mjs';
import { awaitTools } from '/kit/harness.mjs';
import { discover, bind, withInputs } from '/concord/client.mjs';
import { plan, describe, GUARANTEE, RUNG } from '/concord/ladder.mjs';
import { runSaga, OUTCOME } from '/concord/saga.mjs';
import { buildReceipt, verifyReceipt } from '/concord/receipt.mjs';
import { Journal, IndexedStore, LocalStore } from '/concord/journal.mjs';
import { recover } from '/concord/recover.mjs';
import { publishAgentTools } from './agent-tools.mjs';
import { ORIGINS, VENDORS, VENDOR_ORIGINS, TITLES, VERIFIER } from '/config.mjs';
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

const PROMPTS = [
  'Book me London for three nights — flight, hotel and the visa fee.',
  'A flight and a hotel, nothing I cannot take back.',
  'Just hold me a seat.',
  'Flight, visa fee and the entry permit.',
  'A flight and an allocation with Meridian Holdings.',
];

// The sentence a stranger reads before typing anything. Four possible answers,
// and only one of them is a yes without conditions.
const HEADLINE = {
  [GUARANTEE.ATOMIC]:      'Nothing happens until everything agrees.',
  [GUARANTEE.COMPENSATED]: 'All of it can be undone. Some of it happens first.',
  [GUARANTEE.BOUNDED]:     'One of these cannot be taken back.',
  [GUARANTEE.REFUSED]:     'This is not a promise I can make.',
};

// What each rung means for the person who has to live with it. This column,
// not the colour, is the argument.
const CAN_BE = {
  [RUNG.RESERVABLE]:   'cancelled',
  [RUNG.COMPENSABLE]:  'refunded',
  [RUNG.IRREVERSIBLE]: 'not taken back',
};
const RUNG_CLASS = {
  [RUNG.RESERVABLE]: 'r-reservable',
  [RUNG.COMPENSABLE]: 'r-compensable',
  [RUNG.IRREVERSIBLE]: 'r-irreversible',
};

const duration = (s) => {
  if (!s) return null;
  if (s % 60 === 0 && s >= 60) return `${s / 60} min`;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)} min ${s % 60}s`;
};

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
  const main = document.querySelector('main');
  const detail = String(err?.message ?? err);
  if (main) {
    main.innerHTML = `<div class="fatal">
      <p class="margin">this coordinator could not start</p>
      <h1>${esc(context)}</h1>
      <p>${esc(detail)}</p>
      <ul>
        <li>Concord needs its participant origins running. Start them with
          <code>npm run dev</code> and reload — they are separate origins on
          ${esc(VENDOR_ORIGINS.join(', '))}, and the coordinator deliberately cannot
          proceed without hearing from all of them.</li>
        <li>Nothing was contacted and nothing is outstanding. A commitment that cannot be
          planned is never started.</li>
      </ul>
      <p style="margin-top:18px"><button class="primary" onclick="location.reload()">Try again</button></p>
    </div>`;
  }
  $('sub').textContent = 'failed to start';
  globalThis.__CONCORD_ERROR__ = detail;
  console.error(context, err);
}

addEventListener('unhandledrejection', (e) => {
  if (!globalThis.__CONCORD_READY__) fatal(e.reason, 'Something failed while starting up');
});

// ── theme ──────────────────────────────────────────────────────────────────
// Light and dark are two settings of one instrument, not a skin and its
// afterthought. Neither is the "real" one.
{
  const media = matchMedia('(prefers-color-scheme: dark)');
  const shown = () => document.documentElement.dataset.theme || (media.matches ? 'dark' : 'light');
  $('theme').addEventListener('click', () => {
    const next = shown() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('concord.theme', next); } catch { /* private mode */ }
  });
}

$('receiptsLink').href = VERIFIER;

// ── the counterparties ─────────────────────────────────────────────────────
// Embed the participants before asking who is there. Discovery walks the frame
// tree, so a frame created after it has already run is a frame nobody sees --
// which is a coordinator that reports its own vendors unreachable.
//
// One is visible at a time. Five live iframes tiled beside the instrument made
// the page look like a dashboard of five equal things; it is one instrument and
// five counterparties it does not control.
VENDORS.forEach((id, i) => {
  const frame = document.createElement('iframe');
  frame.id = id;
  frame.src = `${ORIGINS[id]}/`;
  frame.allow = 'tools';
  frame.title = TITLES[id];
  frame.loading = 'eager';
  frame.hidden = i > 0;
  frame.setAttribute('role', 'tabpanel');
  frame.setAttribute('aria-labelledby', `tab-${id}`);
  $('frames').append(frame);

  const tab = document.createElement('button');
  tab.type = 'button';
  tab.id = `tab-${id}`;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', id);
  tab.setAttribute('aria-selected', String(i === 0));
  tab.dataset.id = id;
  tab.innerHTML = `<i class="dot" data-dot="${id}"></i>${esc(TITLES[id])}`;
  $('tabs').append(tab);
});

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('button');
  if (!tab) return;
  for (const b of $('tabs').children) b.setAttribute('aria-selected', String(b === tab));
  for (const f of $('frames').children) f.hidden = f.id !== tab.dataset.id;
});

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
const surface = await publishAgentTools({
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

/** A participant is live if it answered the declaration question, by origin --
 *  its declared id need not match the key we filed it under, and one of them
 *  deliberately does not. */
function markLive() {
  const up = new Set(discovered.map((p) => p.origin));
  for (const el of document.querySelectorAll('[data-dot]')) {
    el.className = `dot ${up.has(ORIGINS[el.dataset.dot]) ? 'live' : 'broken'}`;
  }
  $('sub').textContent = `${discovered.length} declarations read`;
}
markLive();

// ── the promise, as the agent was told it ─────────────────────────────────
let proposal = null;      // what the agent last proposed, awaiting a decision
const commitBtn = $('commit');
const crashBtn = $('crash');
const holds = new Map();  // id → epoch ms the declared hold lapses

/** Put the two consent affordances back after a run that removed them. */
function restoreActions() {
  if (!commitBtn.isConnected) $('said').before(commitBtn);
  if (!crashBtn.isConnected) $('reset').before(crashBtn);
}

/** Say a sentence about participants in the names the reader has been shown. */
function named(text) {
  let out = String(text);
  for (const p of discovered) {
    if (!p.title || p.title === p.id) continue;
    out = out.replace(new RegExp(`\\b${p.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), p.title);
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function ledgerRows(order, byId, pointOfNoReturn) {
  return order.map((id) => {
    const p = byId.get(id);
    const steps = p?.protocol?.steps ?? {};
    const rung = steps.reserve ? RUNG.RESERVABLE : steps.compensate ? RUNG.COMPENSABLE
      : steps.execute ? RUNG.IRREVERSIBLE : null;
    const names = Object.values(steps).map((v) => v.tool)
      .filter((t) => t && t !== 'concord.status').join(' → ');
    const ttl = duration(steps.reserve?.ttlSeconds);
    const full = steps.compensate?.refund === 'full';
    const irreversible = rung === RUNG.IRREVERSIBLE;
    return `<tr data-id="${esc(id)}" class="${RUNG_CLASS[rung] ?? ''}">
      <td class="party">${esc(p?.title ?? id)}</td>
      <td class="can${irreversible ? ' no' : ''}">${esc(CAN_BE[rung] ?? 'unknown')}${
        full && rung === RUNG.COMPENSABLE ? ', in full' : ''}</td>
      <td class="step">${esc(names)}</td>
      <td class="num holds" data-ttl="${esc(id)}">${ttl ? esc(ttl) : '—'}</td>
    </tr>${pointOfNoReturn === id
      ? `<tr class="r-irreversible ponr-row"><td colspan="4" class="ponr-note" style="border-left:3px solid var(--irreversible);padding-left:16px">
           Everything above this line can still be undone. Nothing below it can.</td></tr>` : ''}`;
  }).join('');
}

function showPromise(promise) {
  proposal = promise;
  const refused = !promise?.committable;

  $('verdict').textContent = HEADLINE[promise.guarantee] ?? promise.guarantee;
  $('verdict').classList.toggle('is-refusal', refused);
  $('explain').textContent = named(promise.summary ?? '');

  const byId = new Map(discovered.map((p) => [p.id, p]));
  // A refusal has no sequence to lay out, and leaving the previous plan's
  // ladder on screen underneath it reads as though something is still on offer.
  $('ladder').innerHTML = refused ? '' : ledgerRows(promise.order, byId, promise.pointOfNoReturn);
  $('ledgerWrap').hidden = refused;
  $('ladder').classList.remove('narrowing');
  document.querySelector('.ponr-rule')?.remove();

  // The ladder reasons in participant ids because that is what it is given.
  // The person reading has only ever been shown names, and "visa cannot be
  // reversed" beneath a row labelled Consular Fee asks them to do a join.
  $('caveats').innerHTML = (promise.caveats ?? []).map((c) =>
    `<p class="caveat">${esc(named(c))}</p>`).join('');

  // The gate. There is no way to commit anything the agent has not been given
  // permission for, and on a refusal there is no button on the page at all --
  // not a greyed one, which invites a hunt for the way to enable it.
  restoreActions();
  commitBtn.hidden = refused;
  crashBtn.hidden = refused;
  commitBtn.disabled = false;
  $('said').textContent = refused
    ? 'Nothing was contacted, and there is nothing here to go ahead with.'
    : 'Nothing has been contacted. This was worked out from what each site declared about itself.';
}

/**
 * The state a stranger meets before typing anything.
 *
 * The same computation the agent runs, over the set that makes the point, said
 * out loud on load. A page whose whole claim is "you will be told what cannot
 * be undone" should not open by asking you to guess what it does.
 */
function openingPromise() {
  const set = discovered.filter((p) => ['fly', 'stay', 'visa'].includes(p.id));
  if (set.length < 2) return;
  const planned = plan(set);
  showPromise({
    guarantee: planned.guarantee,
    summary: planned.refusal ? `Cannot be done as one commitment. ${planned.refusal}`
      : describe(planned),
    order: planned.order,
    pointOfNoReturn: planned.pointOfNoReturn === null ? null
      : planned.order[planned.pointOfNoReturn],
    caveats: planned.caveats,
    committable: planned.guarantee !== GUARANTEE.REFUSED,
  });
  // Nothing has been proposed by the agent yet, so nothing may be committed.
  proposal = null;
  commitBtn.hidden = true;
  crashBtn.hidden = true;
  $('said').textContent = 'A flight, a hotel and a visa fee — worked out from the declarations '
    + 'below, before you asked for anything. Ask for something else and this changes.';
}

function clearPromise() {
  proposal = null;
  commitBtn.hidden = true;
  crashBtn.hidden = true;
}

// The declared hold durations become a live countdown the moment a hold is
// actually taken, because a number that stops moving is the one people trust
// after it has stopped being true.
const ttlCell = (id) => document.querySelector(`[data-ttl="${CSS.escape(id)}"]`);

setInterval(() => {
  for (const [id, until] of holds) {
    const cell = ttlCell(id);
    if (!cell) continue;
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    cell.textContent = left
      ? `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`
      : 'lapsed';
    cell.classList.toggle('soon', left <= 60);
  }
}, 200);

// ── the conversation ──────────────────────────────────────────────────────
// The label follows the brain, including when it changes mid-conversation
// because the built-in model turned out not to run.
const reader = await makeReader({ onFallback: () => { $('brain').textContent = reader.kind; } });
$('brain').textContent = reader.kind;

function say(who, text, extra = {}) {
  // The agent's own words are put back into the names the reader has been
  // shown. What *you* said is never rewritten -- you asked for a visa fee, and
  // having the page quote you saying "Consular Fee" would be a small lie.
  const body = who === 'you' ? String(text) : named(text);
  $('transcript').insertAdjacentHTML('beforeend',
    `<div class="msg ${who}"><div class="who">${who === 'you' ? 'you' : 'agent'}</div>` +
    `<p>${esc(body)}</p>${extra.calls ?? ''}</div>`);
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

/**
 * Find out who is here, now.
 *
 * A site that registers a commitment surface is available from that moment,
 * with no deployment and no agreement between anyone. toolchange announces it,
 * but the announcement does not reliably cross a frame boundary on every
 * implementation -- a participant that changed its declaration inside an iframe
 * can leave the coordinator holding a stale copy of what it can promise. A
 * proposal has to be over what is true when it is made, so this runs before
 * every one. It is a handful of read-only calls to pages already open.
 */
async function refresh() {
  try {
    const fresh = await discover(ctx, ALL);
    // Compared by what each participant declares, not by who is present. A site
    // that drops its cancel step is the same site and a different proposition,
    // and comparing ids alone makes exactly that change invisible.
    const shape = (list) => list.map((v) =>
      `${v.id}:${Object.keys(v.protocol?.steps ?? {}).sort().join('+')}`).sort().join(',');
    if (shape(fresh) === shape(discovered)) return;

    const was = new Map(discovered.map((v) => [v.id, v]));
    const stepsOf = (v) => Object.keys(v.protocol?.steps ?? {}).sort().join('+');
    const added = fresh.filter((v) => !was.has(v.id));
    const gone = discovered.filter((v) => !fresh.some((q) => q.id === v.id));
    const changed = fresh.filter((v) => was.has(v.id) && stepsOf(was.get(v.id)) !== stepsOf(v));

    discovered = fresh;
    surface.update(withInputs(discovered, INPUTS));
    markLive();

    for (const v of added) {
      say('agent', `${v.title} registered a commitment surface at ${v.origin}. `
        + 'I had never heard of it until now, and I can include it from here.');
    }
    for (const v of gone) say('agent', `${v.title} withdrew its tools and is no longer available.`);
    for (const v of changed) {
      const steps = Object.keys(v.protocol?.steps ?? {}).filter((k) => k !== 'status');
      say('agent', `${v.title} changed what it can commit to — it now declares ${steps.join(', ')}.`);
    }
  } catch { /* whatever is unreachable will be reported by the plan below */ }
}

async function ask(text) {
  say('you', text);
  clearPromise();
  await refresh();
  holds.clear();
  $('run').innerHTML = '';
  $('outcome').innerHTML = '';
  $('receipt').innerHTML = '';
  $('execWrap').hidden = true;

  try {
    const out = await turn({
      text, reader, tool: callTool, say,
      refuse: (why) => showPromise({ ...why, guarantee: 'refused', committable: false, order: [] }),
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
  if (!text || running) return;
  $('q').value = '';

  // Asking something else while a proposal waits is an answer to it. Dropping
  // the new question in silence, which is what happened before, is not.
  if (awaitingGo) {
    const go = awaitingGo;
    awaitingGo = null;
    say('agent', 'Leaving that one, then. Nothing was contacted.');
    go(false);
  }
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

function line(e) {
  const detail = e.ref?.ref ?? e.ref ?? e.error ?? e.cause ?? e.note ?? '';
  const eff = e.type === 'committed' || e.type === 'executed';
  return `<div class="ev${eff ? ' eff' : ''}"><b>${esc(e.type.replace(/_/g, ' '))}</b>` +
         `<span>${esc([e.id, detail].filter(Boolean).join(' · '))}</span></div>`;
}

/**
 * The moment the plan stops being reversible, in the ledger rather than in a
 * log line. Everything still undoable recedes; the row that is about to set
 * thickens; a rule draws itself across the width of the table; and the two ways
 * to stop are taken off the page rather than disabled, because there is no
 * longer anything for them to stop.
 */
function narrow(id) {
  $('ladder').classList.add('narrowing');
  document.querySelector(`tr[data-id="${CSS.escape(id)}"]`)?.classList.add('setting');
  commitBtn.remove();
  crashBtn.remove();
  const rule = document.createElement('div');
  rule.className = 'ponr-rule';
  $('ledgerWrap').after(rule);
  requestAnimationFrame(() => rule.classList.add('draw'));
}

/**
 * A hold that has been released is not un-happened. It is answered.
 *
 * The original entry stays on the ledger, struck through, and the reversal
 * arrives beneath it as its own line naming the step that did it -- which is
 * both how a ledger works and what actually happened at the vendor. Deleting
 * the row would say the seat was never held, and the receipt, which carries
 * both statements, would then disagree with the screen.
 */
function answer(id) {
  const row = document.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
  const back = discovered.find((v) => v.id === id)?.protocol?.steps;
  const reversal = back?.cancel ?? back?.compensate;
  if (!row || !reversal) return;
  holds.delete(id);
  row.classList.add('answered');

  const echo = row.cloneNode(true);
  echo.classList.remove('answered', 'setting');
  echo.classList.add('counter');
  echo.removeAttribute('data-id');
  echo.children[1].textContent = back.cancel ? 'was cancelled' : 'was refunded';
  echo.children[2].textContent = reversal.tool;
  echo.children[3].textContent = '—';
  echo.children[3].removeAttribute('data-ttl');
  row.after(echo);
}

let crashAfter = null;
let lastActor = null;   // whoever was mid-step when it went wrong

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
    <h2>An interrupted commitment was found</h2>
    <p>The coordinator stopped part-way through <code>${esc(s.sagaId)}</code>. These steps are
    outstanding, and something real may be held or charged right now:</p>
    <ul style="color:var(--ink-2);font-size:var(--t-data)">${lines.join('')}</ul>
    <p style="margin-top:10px"><button class="primary" id="resolve">Ask each vendor what happened</button></p>
  </div>`;

  $('resolve').addEventListener('click', async () => {
    $('resolve').disabled = true;
    // Rebuilt from every vendor present, never from whatever is on screen: a
    // recovery scoped to the current selection blamed an absent vendor for
    // being unaskable and stranded its charge.
    const all = withInputs(discovered, INPUTS);
    const reports = await recover({ journal, participants: all, call: bind(ctx, all) });
    const r = reports[0];
    $('pending').innerHTML = `<div class="pending" style="border-left-color:var(--compensable)">
      <h2>Resolved — ${esc(r?.outcome ?? 'nothing outstanding')}</h2>
      <p>${r ? r.reversals.map((x) => `${esc(x.vendor)}.${esc(x.step)} ${x.reversed
        ? `undone via ${esc(x.via)}` : `NOT undone — ${esc(x.why)}`}`).join('<br>') : ''}</p>
      ${r?.unresolved.length ? `<p style="color:var(--fail)">${r.unresolved.map((u) => esc(u.why)).join('<br>')}</p>` : ''}
    </div>`;
  });
}

async function commit() {
  running = true;
  commitBtn.disabled = true;
  crashBtn.disabled = true;
  $('outcome').innerHTML = '';
  $('run').innerHTML = '';
  $('said').textContent = '';
  $('execWrap').hidden = false;
  lastActor = null;

  let phase = null;
  const onEvent = (e) => {
    const group = PHASE[e.type];
    if (group && group !== phase) {
      phase = group;
      $('run').insertAdjacentHTML('beforeend', `<p class="phase-h">${esc(group)}</p>`);
    }
    if (e.type === 'reserved' && e.ttlSeconds) holds.set(e.id, Date.now() + e.ttlSeconds * 1000);
    if (e.type === 'point_of_no_return') narrow(e.id);
    if (['reserve', 'execute', 'confirm'].includes(e.type)) lastActor = e.id;
    if (e.type === 'cancel' || e.type === 'compensate') answer(e.id);
    if (e.type === 'confirmed') {
      // The hold is not counting down any more because it is not a hold any
      // more. Leaving the last number on screen would still read as one.
      holds.delete(e.id);
      const cell = ttlCell(e.id);
      if (cell) { cell.textContent = 'confirmed'; cell.classList.remove('soon'); }
    }
    if (['plan', 'done', 'proposed', 'explained'].includes(e.type)) return;
    $('run').insertAdjacentHTML('beforeend', line(e));
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
    [OUTCOME.UNWOUND]: 'Nothing stands',
    [OUTCOME.IN_DOUBT]: 'In doubt — some effects cannot be reversed',
    [OUTCOME.REFUSED]: 'Refused before contacting anyone',
  }[out.outcome];

  const body = out.outcome === OUTCOME.IN_DOUBT
    ? `<p>${out.stranded?.map(esc).join('<br>') ?? esc(out.cause ?? '')}</p>`
    : out.outcome === OUTCOME.UNWOUND
      // The cause is whatever the failing vendor or the browser said, which is
      // frequently not a sentence anyone wants to read as prose. It is quoted
      // rather than paraphrased -- inventing a nicer reason would be inventing
      // a reason -- and the fact of it is stated first, in words.
      ? `<p>${esc(lastActor ? `${named(lastActor)} could not complete its step, so nothing stands.`
          : 'Nothing stands.')} Every reversible step was reversed; the ledger above shows each
         reversal as its own entry, and the receipt carries both.</p>
         <p class="caveat">What it said: <code>${esc(out.cause ?? 'no reason given')}</code></p>`
      : `<p>${esc((out.stands ?? []).map((id) => TITLES[id] ?? id).join(', '))} — settled together.</p>`;

  $('outcome').innerHTML = `<div class="outcome ${out.outcome}"><h2>${headline}</h2>${body}` +
    (out.unrecorded ? `<p style="color:var(--irreversible-ink)">${esc(out.unrecorded)}</p>` : '') +
    `<p class="margin" style="margin-top:10px">${(out.journal ?? []).length} protocol events</p></div>`;

  if (out.attestations?.length) {
    const receipt = await buildReceipt({
      sagaId: out.journal?.[0]?.sagaId, outcome: out.outcome,
      entries: out.attestations, vendors: out.vendors,
    });
    await renderReceipt(receipt);
    globalThis.__CONCORD_RECEIPT__ = receipt;
  }

  running = false;
  commitBtn.hidden = true;
  crashBtn.hidden = true;
  crashBtn.disabled = false;
  crashAfter = null;
  await showPending();
  globalThis.__CONCORD_LAST__ = out;
}

async function renderReceipt(receipt) {
  const v = await verifyReceipt(receipt);
  const rows = (v.findings[0]?.vendor ? v.findings : []).map((f) =>
    `<div class="rrow"><span class="v">${esc(named(f.vendor))}</span><span class="s">${esc(f.step)}</span>` +
    `<span class="m">in the tree ${f.included ? '✓' : '✗'} · signed by ${esc(f.vendor)} ${f.signed ? '✓' : '✗'}</span>` +
    `<span class="seal${f.included && f.signed ? '' : ' no'}">${f.included && f.signed ? 'sealed' : 'broken'}</span></div>`).join('');

  const broken = v.findings.find((f) => f.why);
  const names = [...new Set(receipt.entries.map((e) => e.statement.vendor))];
  const first = receipt.proofs[0]?.length ?? 0;

  $('receipt').innerHTML = `<div class="receipt">
    <div class="rrow" style="border-bottom:1px solid var(--rule-firm);grid-template-columns:1fr auto">
      <span><span class="margin">receipt root</span><br><span class="root">${esc(receipt.root)}</span></span>
      <span class="seal${v.ok ? '' : ' no'}" style="font-weight:600">${v.ok ? 'VERIFIED' : 'FAILS VERIFICATION'}</span>
    </div>
    ${broken ? `<p style="color:var(--fail);font-size:var(--t-data);padding-top:10px">${esc(broken.why)}</p>` : rows}
    <p style="font-size:var(--t-data);color:var(--ink-2);margin-top:12px;max-width:64ch">
      Each line is a statement its vendor signed with a key that never left its origin.
      ${names[0] ? `${esc(named(names[0]))} verifies its own entries from ${first} opaque hashes,
      without being shown what the others charged.` : ''}</p>
    <p style="margin-top:12px;display:flex;gap:18px;flex-wrap:wrap">
      <a class="quiet" id="elsewhere" href="#" target="_blank" rel="noopener">Check it on another origin</a>
      <button class="quiet" id="tamper">Edit one entry and re-verify</button>
      <button class="quiet" id="export">Download receipt</button></p>
  </div>`;

  // The verdict above was computed by the same page that produced the receipt,
  // which is exactly the arrangement the receipt exists to make unnecessary.
  // This hands it to an origin with no tools, no participants and no route
  // back here, in the URL fragment -- which the browser never sends to a
  // server, so the receipt reaches that origin's script without reaching
  // anybody's host.
  const packed = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(receipt))));
  $('elsewhere').href = `${VERIFIER}/#r=${encodeURIComponent(packed)}`;

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

commitBtn.addEventListener('click', commit);
crashBtn.addEventListener('click', async () => {
  // Two calls in, the hotel has been charged and the coordinator vanishes.
  crashAfter = 2;
  await commit();
  $('run').insertAdjacentHTML('beforeend',
    '<p class="phase-h" style="color:var(--irreversible-ink)">The coordinator stopped here. Nothing ' +
    'unwound, because nothing was left running to unwind it — reload the page and it will be found.</p>');
});
$('reset').addEventListener('click', () => {
  for (const id of VENDORS) $(id)?.contentWindow?.location.reload();
  holds.clear();
  $('run').innerHTML = '';
  $('execWrap').hidden = true;
  $('outcome').innerHTML = '';
  $('receipt').innerHTML = '';
  $('transcript').innerHTML = '';
  setTimeout(async () => {
    discovered = await discover(ctx, ALL);
    markLive();
    clearPromise();
    openingPromise();
  }, 900);
});

try {
  openingPromise();
  await showPending();
} catch (err) {
  // plan() refuses rather than throws for an unpromisable set, so reaching here
  // means something structural -- a participant with no protocol at all.
  fatal(err, 'This commitment could not be planned');
  throw err;
}
globalThis.__CONCORD_READY__ = true;
