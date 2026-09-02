// The receipt verifier, on an origin that is not the coordinator's.
//
// concord-verify does this at a terminal and tools/verify-receipt.mjs does it
// in CI, but a dispute is settled by people, and "npx" is a wall between a
// receipt and most of the people who might one day need to check one. So the
// same code runs here, on its own origin, with no WebMCP, no iframes, and no
// route back to the coordinator.
//
// The important thing this page displays is not the verdict. It is the list of
// origins it contacted to reach that verdict, and the absence of one name from
// that list.

import { verifyReceipt, fetchKeys } from '/concord/receipt.mjs';
import { COORDINATOR, TITLES } from '/config.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&"']/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

$('coordLink').href = COORDINATOR;

{
  const media = matchMedia('(prefers-color-scheme: dark)');
  const shown = () => document.documentElement.dataset.theme || (media.matches ? 'dark' : 'light');
  $('theme').addEventListener('click', () => {
    const next = shown() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('concord.theme', next); } catch { /* private mode */ }
  });
}

/**
 * The default resolver with a witness attached.
 *
 * Every origin this page asks for a key is recorded, in order, with what came
 * back. That record is the evidence for the claim the page makes about itself,
 * and a claim of independence with nothing behind it is just a sentence.
 */
function watchingResolver() {
  const cache = new Map();
  const reached = [];
  const resolve = async (vendor, origin, keyId) => {
    if (!cache.has(origin)) {
      cache.set(origin, fetchKeys(origin).then(
        (doc) => { reached.push({ origin, ok: true, vendor: doc.vendor }); return doc; },
        (err) => { reached.push({ origin, ok: false, why: err.message }); cache.delete(origin); throw err; }));
    }
    const doc = await cache.get(origin);
    if (doc.vendor !== vendor) {
      throw new Error(`${origin} identifies itself as "${doc.vendor}", not "${vendor}"`);
    }
    return doc.keys[keyId] ?? null;
  };
  return { resolve, reached };
}

const named = (v) => TITLES[v] ?? v;

function renderReached(reached) {
  const touched = reached.map((r) => r.origin);
  const askedCoordinator = touched.includes(COORDINATOR);
  return `<section class="reached" aria-labelledby="reached-h">
    <p class="margin" id="reached-h">Every origin this page contacted, in the order it contacted them</p>
    <ol>${reached.map((r) => `<li class="${r.ok ? '' : 'miss'}">${esc(r.origin)}/.well-known/concord.json
      — ${r.ok ? `answers to "${esc(r.vendor)}"` : esc(r.why)}</li>`).join('') || '<li>none</li>'}</ol>
    <p class="absent">${askedCoordinator
      ? `<b>${esc(COORDINATOR)} is in that list.</b> A statement named it as a signing origin, which
         means this receipt is partly the coordinator vouching for itself.`
      : `<b>${esc(COORDINATOR)} is not in that list.</b> The coordinator that produced this receipt
         was not asked anything, and could not have changed this answer.`}</p>
  </section>`;
}

function renderComplaints(v) {
  if (!v.complaints.length && !v.notes.length) return '';
  return `<section class="said" aria-labelledby="said-h">
    <h2 id="said-h">${v.complaints.length ? 'What is wrong with it' : 'What it does not claim'}</h2>
    <ul>${v.complaints.map((c) => `<li class="bad">${esc(c)}</li>`).join('')}
        ${v.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
  </section>`;
}

function renderEntries(receipt, v) {
  return `<section class="entries" aria-label="The statements in this receipt">
    <table>
      <caption class="margin" style="text-align:left;padding:10px 0 6px">
        Each line is a statement its vendor signed with a key that never left its origin
      </caption>
      <thead><tr>
        <th scope="col">Party</th><th scope="col">Step</th><th scope="col">Key</th>
        <th scope="col">In the tree</th><th scope="col">Signed by the party it names</th>
        <th scope="col">&nbsp;</th>
      </tr></thead>
      <tbody>${v.findings.map((f) => `<tr class="${f.ok ? '' : 'no'}">
        <td>${esc(named(f.vendor))}</td>
        <td>${esc(f.step ?? '')}</td>
        <td>${esc(f.keyId ?? '—')}</td>
        <td>${f.included ? '✓' : '✗'}</td>
        <td>${f.signed ? '✓' : `✗ ${esc(f.why ?? '')}`}</td>
        <td class="seal${f.ok ? '' : ' no'}">${f.ok ? 'sealed' : 'broken'}</td>
      </tr>`).join('')}</tbody>
    </table>
    <p class="margin" style="padding:12px 0 0">receipt root</p>
    <p class="root">${esc(receipt.root)}</p>
  </section>`;
}

/** Say what is wrong with the file before pretending it is a receipt. */
function shaped(receipt) {
  if (!receipt || typeof receipt !== 'object') return 'That is not a JSON object.';
  for (const [field, kind] of [['sagaId', 'string'], ['root', 'string'], ['entries', 'object']]) {
    if (typeof receipt[field] !== kind) return `That is not a Concord receipt: it has no ${field}.`;
  }
  if (!Array.isArray(receipt.entries) || !receipt.entries.length) {
    return 'That receipt contains no statements, so there is nothing to verify.';
  }
  return null;
}

let running = false;

async function check(text, how) {
  if (running) return;
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch (err) {
    return refuse('That file is not readable JSON.', err.message);
  }
  const wrong = shaped(receipt);
  if (wrong) return refuse(wrong, 'Nothing was fetched, because there was nothing to check.');

  running = true;
  globalThis.__CONCORD_RECEIPT__ = receipt;
  $('verdict').textContent = 'Checking…';
  $('verdict').className = 'hero idle';
  $('explain').textContent = `Fetching key documents from the origins named inside the statements.`;
  $('out').innerHTML = '';

  const witness = watchingResolver();
  let v;
  try {
    v = await verifyReceipt(receipt, witness.resolve);
  } catch (err) {
    running = false;
    return refuse('This receipt could not be checked.', err.message);
  }

  $('verdict').textContent = v.ok ? 'This receipt verifies.' : 'This receipt does not verify.';
  $('verdict').className = `hero${v.ok ? '' : ' no'}`;
  $('explain').textContent = v.ok
    ? `${v.findings.length} statements, ${new Set(v.findings.map((f) => f.vendor)).size} parties, `
      + `commitment ${receipt.sagaId}, outcome "${receipt.outcome}". Every statement hashes into the `
      + 'stated root and was signed by the party it names, with a key that origin publishes and that '
      + 'was in force when the statement is dated.'
    : `Commitment ${receipt.sagaId}, outcome "${receipt.outcome}". At least one thing below did not `
      + 'check out. A receipt that fails here is not evidence of anything, in either direction — it '
      + 'is a document nobody should act on.';

  $('out').innerHTML = renderComplaints(v) + renderEntries(receipt, v) + renderReached(witness.reached);
  $('sub').textContent = how;
  $('clear').hidden = false;
  running = false;
  globalThis.__CONCORD_VERDICT__ = { ok: v.ok, reached: witness.reached.map((r) => r.origin) };
}

function refuse(headline, detail) {
  $('verdict').textContent = headline;
  $('verdict').className = 'hero no';
  $('explain').textContent = detail;
  $('out').innerHTML = '';
  $('clear').hidden = false;
  globalThis.__CONCORD_VERDICT__ = { ok: false, reached: [] };
}

// ── ways in ────────────────────────────────────────────────────────────────
$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const f = $('file').files?.[0];
  if (f) await check(await f.text(), `${f.name} · ${f.size} bytes`);
});
$('paste').addEventListener('input', () => {
  const text = $('paste').value.trim();
  if (text.startsWith('{') && text.endsWith('}')) check(text, 'pasted');
});
$('clear').addEventListener('click', () => {
  $('paste').value = '';
  $('file').value = '';
  $('out').innerHTML = '';
  $('clear').hidden = true;
  $('sub').textContent = 'receipts';
  $('verdict').textContent = 'Give me a receipt.';
  $('verdict').className = 'hero idle';
  $('explain').textContent = 'This origin has no tools, embeds nothing, and has never spoken to the '
    + 'coordinator that produced your file.';
  location.hash = '';
});

const drop = $('drop');
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, () => drop.classList.remove('over'));
}
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) await check(await f.text(), `${f.name} · ${f.size} bytes`);
});

/**
 * A receipt handed over in the URL fragment.
 *
 * The coordinator links here with the receipt in `#r=`, which is the shortest
 * honest path from "it says it committed" to "somebody else agrees". A fragment
 * is never sent to a server, so the receipt reaches this origin's JavaScript
 * without reaching this origin's host -- and this host has no backend to reach.
 */
function fromFragment() {
  const m = /[#&]r=([^&]+)/.exec(location.hash);
  if (!m) return null;
  try {
    const bytes = Uint8Array.from(atob(decodeURIComponent(m[1])), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch { return null; }
}

const handed = fromFragment();
if (handed) await check(handed, 'handed over in the URL');
addEventListener('hashchange', () => { const t = fromFragment(); if (t) check(t, 'handed over in the URL'); });

globalThis.__CONCORD_CHECK__ = check;
globalThis.__CONCORD_READY__ = true;
