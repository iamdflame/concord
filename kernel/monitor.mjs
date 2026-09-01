// Ring 0 — the kernel monitor.
//
// This is an instrument, not a page about an instrument. The axis is the
// primary control: dragging it does not scrub a recording, it reconstructs the
// system from the transcript at that instant. Every lane, label and effect you
// see at a given position was derived on the spot by replaying what crossed the
// boundary, which is why the past can show a system that has not been attacked
// yet rather than a dimmed copy of the present.

import { resolveModelContext } from '/shim/adapter.mjs';
import { awaitTools } from './harness.mjs';
import { parsePolicy } from './policy.mjs';
import { Kernel } from './dispatch.mjs';
import { reconstruct } from './transcript.mjs';
import { MAIL, LEDGER, PAY, ALL } from './processes.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<&]/g, (c) => ({ '<': '&lt;', '&': '&amp;' }[c]));
const short = (origin) => ({ [MAIL]: 'mail', [LEDGER]: 'ledger', [PAY]: 'pay' }[origin] ?? 'kernel');
const usd = (minor) => `$${(minor / 100).toFixed(2)}`;

const { ctx, provider } = await resolveModelContext();
const policy = parsePolicy(await (await fetch('./policy.ring')).text());

const kernel = new Kernel({ modelContext: ctx, policy, confirm: async () => true });

const NEEDED = ['read_thread', 'get_balance', 'list_invoices', 'send_funds', 'list_transfers'];
const tools = await awaitTools(ctx, ALL, (t) => NEEDED.every((n) => t.some((x) => x.name === n)));
const pick = (origin, name) => tools.find((t) => t.origin === origin && t.name === name);

// ── the session under observation ───────────────────────────────────────────
const invoice = (await kernel.dispatch(pick(LEDGER, 'list_invoices'), { status: 'open' })).invoices[0];
await kernel.dispatch(pick(MAIL, 'read_thread'), { thread: invoice.id });
await kernel.dispatch(pick(LEDGER, 'get_balance'), { account: 'acct_main' });
try {
  await kernel.dispatch(pick(PAY, 'send_funds'), {
    to: 'acct_attacker_9f', minor: invoice.minor, memo: `Remittance for ${invoice.id} per automated notice`,
  });
} catch { /* the denial belongs in the trace */ }
await kernel.dispatch(pick(PAY, 'send_funds'), {
  to: 'acct_supplier', minor: invoice.minor, memo: `Settlement ${invoice.id}`,
});

const entries = kernel.transcript.entries;
const chain = await kernel.transcript.verify();

// ── time base ───────────────────────────────────────────────────────────────
const t0 = entries[0].t;
const t1 = Math.max(...entries.map((e) => e.t + (e.ms ?? 2)));
const span = Math.max(1, (t1 - t0) * 1.08);   // tail so the last call is not clipped
const pct = (t) => ((t - t0) / span) * 100;

const LANES = ['kernel', ...ALL];
let cursor = entries.length - 1;      // index of the last entry that has happened
let selected = entries.length - 1;

// ── trace ───────────────────────────────────────────────────────────────────
$('lanes').innerHTML = LANES.map((lane) => {
  const name = lane === 'kernel' ? 'kernel' : short(lane);
  const sub = lane === 'kernel' ? 'ring0' : lane.replace('http://localhost:', ':');
  return `<div class="lane-name"><i class="chip" data-chip="${esc(lane)}"></i>` +
         `<span>${name}</span><span style="color:var(--muted)">${sub}</span></div>` +
         `<div class="lane" data-lane="${esc(lane)}"></div>`;
}).join('');

for (const [i, e] of entries.entries()) {
  const origin = e.toolId.replace(/\/[^/]+$/, '');
  const denied = e.kind === 'deny';
  // A denial belongs on the kernel's lane. Drawing it on the target's lane
  // would show a call that origin never actually received.
  const laneKey = denied ? 'kernel' : origin;
  const lane = $('lanes').querySelector(`.lane[data-lane="${CSS.escape(laneKey)}"]`);
  const cls = denied ? 'deny'
            : e.labelTags?.includes('UNTRUSTED') ? 'tainted'
            : e.effect === 'write' ? 'write' : 'read';
  const name = e.toolId.split('/').pop();
  // A denial has no duration to draw, so it gets a fixed slot wide enough to
  // read. Squeezing it to the width of an instant clipped the one word that
  // matters.
  const w = denied ? 8 : Math.max(((e.ms ?? 2) / span) * 100, 5.5);
  lane.insertAdjacentHTML('beforeend',
    `<div class="blk ${cls}" data-i="${i}" style="left:${pct(e.t).toFixed(2)}%;width:${w.toFixed(2)}%" ` +
    `title="${esc(denied ? `refused ${e.toolId}` : e.toolId)}">${denied ? 'REFUSED' : esc(name)}</div>`);
}

// axis ticks at the moments something happened, because nothing else is worth
// marking on a timeline whose whole purpose is to land on those moments
$('ticks').innerHTML = entries.map((e, i) =>
  `<div class="tick${i % 2 === 0 ? ' major' : ''}" style="left:${pct(e.t).toFixed(2)}%"></div>` +
  (i % 2 === 0 ? `<div class="tick-t" style="left:${pct(e.t).toFixed(2)}%">${(e.t - t0).toFixed(0)}ms</div>` : '')
).join('');

// ── rendering a moment ──────────────────────────────────────────────────────
function render() {
  const state = reconstruct(entries, cursor);
  const now = entries[cursor];

  const at = pct(now.t + (now.ms ?? 2));
  $('head').style.left = `${at.toFixed(2)}%`;
  $('headT').textContent = `t+${(now.t - t0).toFixed(0)}ms · step ${cursor + 1}/${entries.length}`;
  $('headT').style.cssText = at > 62
    ? 'left:auto;right:8px;text-align:right'
    : 'left:8px;right:auto';
  $('scrub').setAttribute('aria-valuenow', String(cursor));
  $('scrub').setAttribute('aria-valuetext', `step ${cursor + 1} of ${entries.length}, ${now.toolId}`);

  for (const blk of document.querySelectorAll('.blk')) {
    const i = Number(blk.dataset.i);
    blk.classList.toggle('done', i <= cursor);
    blk.classList.toggle('sel', i === selected);
  }

  for (const chip of document.querySelectorAll('.chip')) {
    const lane = chip.dataset.chip;
    const stat = state.origins.get(lane);
    chip.classList.toggle('live', Boolean(stat));
    chip.classList.toggle('tainted', Boolean(stat?.tainted));
  }

  const tags = state.context.tags;
  $('tags').innerHTML = tags.length
    ? tags.map((t) => {
        const cls = t === 'UNTRUSTED' ? 'untrusted' : t === 'TAINTED_CONTEXT' ? 'floor' : '';
        return `<span class="tag ${cls}">${esc(t.replace('origin:http://localhost:', 'origin :'))}</span>`;
      }).join('')
    : '<span class="tag none">no labels yet</span>';

  $('procTable').innerHTML = LANES.filter((l) => l !== 'kernel').map((origin) => {
    const s = state.origins.get(origin) ?? { calls: 0, denied: 0, tainted: false };
    const trust = s.tainted ? '<span class="state-taint">untrusted source</span>'
                : s.calls ? '<span class="state-ok">clean</span>'
                : '<span style="color:var(--muted)">idle</span>';
    return `<tr><td>${short(origin)}</td><td class="num">${s.calls}</td>` +
           `<td class="num${s.denied ? ' state-deny' : ''}">${s.denied}</td><td>${trust}</td></tr>`;
  }).join('');

  $('settled').innerHTML = state.settled.length
    ? state.settled.map((e) => `<div class="ruling allowed"><b>${esc(e.args.to)} · ${usd(e.args.minor)}</b>` +
        `<p>${esc(e.args.memo ?? '')}</p></div>`).join('')
    : '<span class="empty">nothing has settled</span>';

  $('calls').textContent = state.origins.size ? entries.slice(0, cursor + 1).filter((e) => e.kind === 'call').length : 0;
  $('denied').textContent = state.denials.length;
  $('denied').className = state.denials.length ? 'state-deny' : '';

  renderDetail(entries[selected]);
}

function renderDetail(e) {
  if (!e) { $('detail').innerHTML = '<span class="empty">nothing selected</span>'; return; }
  const denied = e.kind === 'deny';
  const cls = denied ? 'denied' : e.confirmed ? 'confirmed' : 'allowed';
  const verdict = denied ? 'REFUSED' : e.confirmed ? 'ALLOWED AFTER CONFIRMATION' : 'ALLOWED';

  const evidence = (e.evidence ?? []).length
    ? `<h2>why</h2><p class="hint" style="margin-bottom:10px">The argument reuses content that arrived
       from a source the site does not author, and no independent origin corroborates it.</p>` +
      (e.evidence ?? []).map((ev) =>
        `<div class="kv"><dt>field</dt><dd><span class="ev">${esc(ev.field)}</span></dd>` +
        `<dt>value</dt><dd><span class="ev">${esc(ev.token)}</span></dd>` +
        `<dt>came from</dt><dd>${esc(ev.source)}</dd></div>`).join('')
    : '';

  $('callTitle').textContent = `step ${e.seq + 1} · ${e.toolId.split('/').pop()}`;
  $('detail').innerHTML =
    `<div class="ruling ${cls}"><b>${verdict}</b><p>${esc(e.reason ?? 'permitted by policy')}</p></div>` +
    `<div class="kv">` +
      `<dt>tool</dt><dd>${esc(e.toolId)}</dd>` +
      `<dt>effect</dt><dd>${esc(e.effect)} · egress ${esc(e.egress)}</dd>` +
      `<dt>label</dt><dd>${esc(e.label)}</dd>` +
      `<dt>digest</dt><dd style="color:var(--muted)">${esc(e.hash)}</dd>` +
    `</div>` +
    `<h2>arguments</h2><pre>${esc(JSON.stringify(e.args, null, 2))}</pre>` +
    (e.rule ? `<h2>rule that decided this</h2><pre>${esc(e.rule)}</pre>` : '') +
    evidence +
    (e.result !== undefined ? `<h2>returned</h2><pre>${esc(JSON.stringify(e.result, null, 2)).slice(0, 900)}</pre>` : '');
}

// ── the scrub ───────────────────────────────────────────────────────────────
// Position maps continuously to kernel time; the cursor is the last call that
// had happened by then. Releasing does not snap, because the gap between two
// calls is a real interval in which the system genuinely was in that state.
const scrub = $('scrub');
function seek(clientX) {
  const box = scrub.getBoundingClientRect();
  const at = t0 + ((clientX - box.left) / box.width) * span;
  let i = 0;
  while (i + 1 < entries.length && entries[i + 1].t <= at) i++;
  if (cursor !== i) { cursor = i; selected = i; render(); }
}
scrub.addEventListener('pointerdown', (e) => { scrub.setPointerCapture(e.pointerId); seek(e.clientX); });
scrub.addEventListener('pointermove', (e) => { if (scrub.hasPointerCapture(e.pointerId)) seek(e.clientX); });
scrub.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -1, ArrowRight: 1, Home: -entries.length, End: entries.length }[e.key];
  if (step === undefined) return;
  e.preventDefault();
  cursor = selected = Math.min(entries.length - 1, Math.max(0, cursor + step));
  render();
});
document.addEventListener('click', (e) => {
  const blk = e.target.closest('.blk');
  if (!blk) return;
  selected = cursor = Number(blk.dataset.i);
  render();
});

// ── boot ────────────────────────────────────────────────────────────────────
$('session').textContent = `session ${entries.at(-1).hash.slice(0, 8)}`;
$('provider').textContent = provider === 'native' ? 'native WebMCP' : 'shim';
$('provider').className = provider === 'native' ? 'state-ok' : '';
$('procs').textContent = String(ALL.length);
$('chain').textContent = chain.ok ? 'verified' : `broken @${chain.brokenAt}`;
$('chain').className = chain.ok ? 'state-ok' : 'state-deny';
scrub.setAttribute('aria-valuemax', String(entries.length - 1));
render();

globalThis.__RING0_MONITOR__ = { entries, reconstruct, kernel };
globalThis.__RING0_RESULTS__ = { done: true, verdict: chain.ok ? 'PASS' : 'FAIL', provider, rows: [] };
