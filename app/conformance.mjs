// The conformance suite, over the participants here and over anything you name.
//
// The page has claimed since it was written that you can point it at your own
// origin. Doing that needs two things it did not have: somewhere to type the
// origin, and a Permissions-Policy on this document permissive enough to
// delegate `tools` to an origin nobody listed in advance. Both are here now --
// deploy/build.mjs serves this one path as `tools=*`, and says why.

import { resolveModelContext } from '/shim/adapter.mjs';
import { awaitTools } from '/kit/harness.mjs';
import { conform } from '/spec/conformance.mjs';
import { ORIGINS, VENDORS, VENDOR_ORIGINS, TITLES } from '/config.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&"']/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

const LEVEL = ['unusable', 'declares', 'recoverable', 'attesting'];

{
  const media = matchMedia('(prefers-color-scheme: dark)');
  const shown = () => document.documentElement.dataset.theme || (media.matches ? 'dark' : 'light');
  $('theme').addEventListener('click', () => {
    const next = shown() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('concord.theme', next); } catch { /* private mode */ }
  });
}

$('thisOrigin').textContent = location.origin;

for (const id of VENDORS) {
  const f = document.createElement('iframe');
  Object.assign(f, { id, src: `${ORIGINS[id]}/`, allow: 'tools', title: TITLES[id] });
  $('frames').append(f);
}

const { ctx, provider } = await resolveModelContext();
await awaitTools(ctx, VENDOR_ORIGINS, (t) =>
  VENDOR_ORIGINS.every((o) => t.some((x) => x.origin === o && x.name === 'concord.protocol')));

function render(result, title) {
  const level = result.level ?? 0;
  const failed = result.checks.filter((c) => !c.ok).length;
  return `<section class="subject l${level}">
    <div class="sh">
      <h2>${esc(title ?? result.id ?? new URL(result.origin).hostname)}</h2>
      <span class="lvl">L${level} · ${LEVEL[level]}</span>
      <span class="rung">${esc(result.rung ?? '')}</span>
      <span class="where">${esc(result.origin)}</span>
    </div>
    <div class="checks"><table>
      <thead><tr>
        <th scope="col">&nbsp;</th><th scope="col">Level</th>
        <th scope="col">Check</th><th scope="col">Section of the spec</th>
      </tr></thead>
      <tbody>${result.checks.map((c) => `<tr class="${c.ok ? '' : 'no'}">
        <td class="mark">${c.ok ? '✓' : '✗'}</td>
        <td class="sec">L${c.level}</td>
        <td>${esc(c.id)}</td>
        <td class="why">${esc(c.section)}${c.ok ? '' : ` — ${esc(c.why)}`}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${failed ? `<p class="note bad">${failed} check${failed === 1 ? '' : 's'} failed. The level above
      is the highest one every check below it passed, so this participant can be used for what L${level}
      allows and no more.</p>` : ''}
  </section>`;
}

const results = [];
$('out').innerHTML = '';

for (const id of VENDORS) {
  const r = await conform({ ctx, origin: ORIGINS[id] });
  results.push(r);
  $('out').insertAdjacentHTML('beforeend', render(r, TITLES[id] ?? id));
}

const worst = Math.min(...results.map((r) => r.level));
const best = Math.max(...results.map((r) => r.level));
$('verdict').textContent = worst === best
  ? `Every participant here meets L${worst}.`
  : `The weakest participant here meets L${worst}.`;
$('verdict').classList.toggle('short', worst < 2);
$('sub').textContent = `${results.length} participants · provider ${provider}`;

// ── point it at your own origin ────────────────────────────────────────────

/**
 * Check an origin this page has never heard of.
 *
 * Everything that can go wrong here goes wrong silently in a browser, so each
 * one is named: a page that will not frame, a page that frames but registers
 * nothing, and a page that registers tools but not a commitment declaration are
 * three different problems with three different fixes, and "L0" alone tells
 * somebody debugging their own participant nothing at all.
 */
async function check(raw) {
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    return fail(raw, 'That is not a URL. An origin looks like https://example.com.');
  }
  if (!/^https?:$/.test(new URL(origin).protocol)) {
    return fail(origin, 'Only http and https origins can register tools.');
  }
  // A secure context is required for the API. http://localhost is one; other
  // plain-http origins are not, and the failure is silent.
  if (new URL(origin).protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/
      .test(new URL(origin).hostname)) {
    return fail(origin, 'WebMCP needs a secure context. Serve this origin over HTTPS and try again.');
  }
  if (results.some((r) => r.origin === origin)) {
    return fail(origin, 'That origin is already checked above.');
  }

  $('sub').textContent = `asking ${origin}…`;
  const id = `guest-${results.length}`;
  document.querySelector(`iframe[data-guest="${CSS.escape(origin)}"]`)?.remove();
  const frame = document.createElement('iframe');
  Object.assign(frame, { id, src: `${origin}/`, allow: 'tools', title: origin });
  frame.dataset.guest = origin;
  $('frames').append(frame);

  const loaded = await new Promise((resolve) => {
    const done = (ok) => resolve(ok);
    frame.addEventListener('load', () => done(true), { once: true });
    frame.addEventListener('error', () => done(false), { once: true });
    setTimeout(() => done(false), 15_000);
  });
  if (!loaded) {
    return fail(origin, 'That page did not load in this frame within fifteen seconds. A '
      + 'Content-Security-Policy frame-ancestors or X-Frame-Options header will do that, '
      + 'and a participant nothing can embed is a participant no coordinator can use.');
  }

  // Registration is asynchronous on the participant's side, so absence has to
  // be waited out rather than assumed on the first look.
  let saw = false;
  for (let i = 0; i < 40 && !saw; i++) {
    saw = (await ctx.getTools()).some((t) => t.origin === origin);
    if (!saw) await new Promise((r) => setTimeout(r, 250));
  }
  if (!saw) {
    // Two very different situations that are identical from out here, and the
    // second is the likely one for anything already built to this spec: every
    // participant in this repository registers with exposedTo: [coordinator],
    // because tools that move money should be reachable by one named embedder
    // and not by whoever manages to frame the page. A participant doing the
    // safer thing and a participant doing nothing are indistinguishable to a
    // document neither of them has named, so both are said.
    return fail(origin, 'That page loaded, but no tools from it are visible here. Most likely it '
      + `exposes its tools to one named origin and this is not that origin — add ${location.origin} `
      + 'to its exposedTo while you test. Otherwise it registers no tools at all, or it registers '
      + 'them without exposedTo, which keeps them from every embedder including this one.');
  }

  const r = await conform({ ctx, origin });
  results.push(r);
  $('out').insertAdjacentHTML('beforeend', render(r));
  $('sub').textContent = `${results.length} participants · provider ${provider}`;
  document.querySelector('#out > section:last-of-type').scrollIntoView({ block: 'start' });
  return r;
}

function fail(origin, why) {
  $('out').insertAdjacentHTML('beforeend', `<section class="subject l0">
    <div class="sh"><h2>${esc(origin)}</h2><span class="lvl">not checked</span></div>
    <p class="note bad">${esc(why)}</p></section>`);
  $('sub').textContent = `${results.length} participants · provider ${provider}`;
  document.querySelector('#out > section:last-of-type').scrollIntoView({ block: 'start' });
  return null;
}

$('ask').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('origin').value.trim();
  if (!raw) return;
  const button = $('ask').querySelector('button');
  button.disabled = true;
  try { await check(raw); } finally { button.disabled = false; }
});

// So a result can be linked to, and so the suite can be driven from a script.
const asked = new URL(location.href).searchParams.get('origin');
if (asked) { $('origin').value = asked; await check(asked); }

document.title = `RING0_VERDICT ${worst >= 2 ? 'PASS' : 'FAIL'}`;
globalThis.__RING0_RESULTS__ = {
  done: true, verdict: worst >= 2 ? 'PASS' : 'FAIL', provider,
  rows: results.flatMap((r) => r.checks.map((c) => ({
    id: `${r.id}.${c.id}`, state: c.ok ? 'pass' : 'fail', assertion: c.section }))),
  levels: Object.fromEntries(results.map((r) => [r.id, r.level])),
};
globalThis.__CONCORD_CHECK__ = check;
