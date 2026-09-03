// The five-minute path, and a live roll call of every origin.
//
// The links carry the question, so nothing has to be typed. The table below
// them is the status page: it is fetched from the reader's own browser rather
// than from a cron job we run, because a badge we generate is a claim about
// our own infrastructure and this is the reader watching eight independent
// origins answer for themselves.

import { ORIGINS, VENDORS, COORDINATOR, VERIFIER, TITLES } from '/config.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&"']/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

{
  const media = matchMedia('(prefers-color-scheme: dark)');
  const shown = () => document.documentElement.dataset.theme || (media.matches ? 'dark' : 'light');
  $('theme').addEventListener('click', () => {
    const next = shown() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('concord.theme', next); } catch { /* private mode */ }
  });
}

const TRIP = 'Book me London for three nights — flight, hotel and the visa fee.';
const IMPOSSIBLE = 'Flight, visa fee and the entry permit.';
const ask = (q) => `${COORDINATOR}/?ask=${encodeURIComponent(q)}`;

$('s1').href = ask(TRIP);
$('s2').href = ask(TRIP);
$('s3').href = ask(IMPOSSIBLE);
$('s5').href = VERIFIER;
$('coordName').textContent = COORDINATOR;
for (const id of ['s1', 's2', 's3', 's5']) $(id).target = '_blank';

// ── the roll call ──────────────────────────────────────────────────────────
//
// Each participant is asked for the document it publishes about itself. What
// matters is not that it answers but that it answers *as itself*: the key
// document names the vendor, and a receipt resolves keys from here rather
// than from anything the coordinator wrote.
const rows = [];
const check = async (id, origin, kind) => {
  const row = { id, origin, kind, up: false, vendor: '—', keyId: '—', delegates: '—' };
  try {
    const res = await fetch(origin, { mode: 'cors' }).catch(() => null);
    row.delegates = res?.headers.get('permissions-policy')?.replace(/^tools=/, '') ?? 'not readable';
  } catch { /* cross-origin headers are usually not readable, and that is fine */ }

  if (kind === 'participant') {
    try {
      const doc = await (await fetch(`${origin}/.well-known/concord.json`)).json();
      row.vendor = doc.vendor;
      row.keyId = doc.keys?.[0]?.keyId ?? 'none published';
      row.up = doc.vendor === id;
    } catch { row.up = false; row.vendor = 'no key document'; }
  } else {
    // The coordinator and the verifier sign nothing, so having no key document
    // is the correct answer for both and is checked as such.
    const res = await fetch(`${origin}/.well-known/concord.json`).catch(() => null);
    row.vendor = kind;
    row.keyId = res?.ok ? 'publishes a key it should not' : 'none, and none expected';
    row.up = !res?.ok;
  }
  return row;
};

const targets = [
  ...VENDORS.map((id) => ({ id, origin: ORIGINS[id], kind: 'participant' })),
  { id: 'coordinator', origin: COORDINATOR, kind: 'coordinator' },
  { id: 'verifier', origin: VERIFIER, kind: 'verifier' },
];

const results = await Promise.all(targets.map((t) => check(t.id, t.origin, t.kind)));
rows.push(...results);

$('rows').innerHTML = rows.map((r) => `<tr class="${r.up ? 'up' : 'down'}">
  <td>${esc(TITLES[r.id] ?? r.id)}</td>
  <td>${esc(r.vendor)}</td>
  <td>${esc(r.keyId)}</td>
  <td>${esc(String(r.delegates).slice(0, 60))}</td>
</tr>`).join('');

const down = rows.filter((r) => !r.up);
$('summary').textContent = down.length
  ? `${down.length} of ${rows.length} did not answer as themselves: ${down.map((r) => r.id).join(', ')}. `
    + 'Concord plans over whoever is present, so the coordinator still works — it names the absent '
    + 'ones in its own header rather than refusing to start.'
  : `All ${rows.length} answered as themselves. Each participant publishes a key naming itself, `
    + 'and the coordinator and the verifier publish none, because neither signs anything.';

globalThis.__CONCORD_READY__ = true;
globalThis.__JUDGE__ = { rows, down: down.length };
