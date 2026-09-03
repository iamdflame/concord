// The forge, in a browser.
//
// attacks/run.mjs fires these headless and fails the build on a single
// acceptance. This is the same set, with a button, because "our verifier
// rejects forgeries" is a claim somebody should be able to test rather than
// read. Airlock's ?attack=1 is the same idea and it is the most persuasive
// thing in that repository.

import { verifyReceipt } from '/concord/receipt.mjs';
import { ATTACKS, honestReceipt } from '/attacks/browser.mjs';

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

$('count').textContent = `${ATTACKS.length} attacks, none of them fired yet`;

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  $('rows').innerHTML = '';
  $('verdict').textContent = 'Firing…';
  $('verdict').className = 'hero';

  const honest = await honestReceipt();
  const control = await verifyReceipt(honest.receipt, honest.resolve);
  if (!control.ok) {
    // The control failing means the forge is broken, not the verifier. Saying
    // "all attacks rejected" on a harness that cannot build an honest receipt
    // would be the same kind of lie the attacks are looking for.
    $('verdict').textContent = 'The forge itself is broken.';
    $('verdict').className = 'hero no';
    $('explain').textContent = `An honest receipt did not verify: ${control.complaints[0]}`;
    $('run').disabled = false;
    return;
  }

  let through = 0;
  for (const { name, why, run } of ATTACKS) {
    const v = await run(honest);
    const rejected = !v.ok;
    if (!rejected) through++;
    $('rows').insertAdjacentHTML('beforeend', `<tr class="${rejected ? 'rejected' : 'accepted'}">
      <td>${rejected ? 'rejected' : 'ACCEPTED'}</td>
      <td class="what">${esc(name)}<br><span class="why" style="font-size:var(--t-cap)">${esc(why)}</span></td>
      <td class="why">${esc(rejected ? (v.complaints[0] ?? '—') : 'nothing — it verified clean')}</td>
    </tr>`);
    // One at a time, visibly. A table that appears all at once looks precomputed.
    await new Promise((r) => setTimeout(r, 60));
  }

  $('verdict').textContent = through
    ? `${through} got through.`
    : 'None of them got through.';
  $('verdict').className = `hero${through ? ' no' : ''}`;
  $('explain').textContent = through
    ? 'That is a hole, and it is the honest result of running this. The headless '
      + 'version of these attacks fails the build for exactly this reason.'
    : `All ${ATTACKS.length} forged receipts were rejected, and the honest one verified. `
      + 'Each rejection above names what the verifier objected to.';
  $('count').textContent = `${ATTACKS.length} attacks · ${ATTACKS.length - through} rejected`;
  $('run').disabled = false;
  globalThis.__CONCORD_ATTACKS__ = { total: ATTACKS.length, accepted: through };
});

globalThis.__CONCORD_READY__ = true;
