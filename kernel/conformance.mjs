// Runs the conformance suite against every participant in the origin table.
import { resolveModelContext } from '/shim/adapter.mjs';
import { awaitTools } from './harness.mjs';
import { conform } from '/spec/conformance.mjs';
import { ORIGINS, VENDORS, VENDOR_ORIGINS, TITLES } from '/config.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&"']/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

for (const id of VENDORS) {
  const f = document.createElement('iframe');
  Object.assign(f, { id, src: `${ORIGINS[id]}/`, allow: 'tools', title: TITLES[id] });
  $('frames').append(f);
}

const { ctx, provider } = await resolveModelContext();
await awaitTools(ctx, VENDOR_ORIGINS, (t) =>
  VENDOR_ORIGINS.every((o) => t.some((x) => x.origin === o && x.name === 'concord.protocol')));

const results = [];
$('out').innerHTML = '';

for (const id of VENDORS) {
  const r = await conform({ ctx, origin: ORIGINS[id] });
  results.push(r);
  $('out').insertAdjacentHTML('beforeend', `<div class="vendor">
    <div class="vh"><b>${esc(TITLES[id] ?? id)}</b>
      <span class="lvl l${r.level}">L${r.level}${['unusable','declares','recoverable','attesting'][r.level] ? ' · ' + ['unusable','declares','recoverable','attesting'][r.level] : ''}</span>
      <span class="origin">${esc(r.rung ?? '')} · ${esc(r.origin)}</span></div>
    ${r.checks.map((c) => `<div class="chk">
      <span class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'}</span>
      <span class="sec">L${c.level}</span>
      <span>${esc(c.id)}</span>
      <span class="why">${esc(c.section)}${c.ok ? '' : ' — ' + esc(c.why)}</span>
    </div>`).join('')}
  </div>`);
}

const worst = Math.min(...results.map((r) => r.level));
document.title = `RING0_VERDICT ${worst >= 2 ? 'PASS' : 'FAIL'}`;
globalThis.__RING0_RESULTS__ = {
  done: true, verdict: worst >= 2 ? 'PASS' : 'FAIL', provider,
  rows: results.flatMap((r) => r.checks.map((c) => ({
    id: `${r.id}.${c.id}`, state: c.ok ? 'pass' : 'fail', assertion: c.section }))),
  levels: Object.fromEntries(results.map((r) => [r.id, r.level])),
};
