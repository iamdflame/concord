// The sandbox: write a participant, and watch the guarantee change.
//
// The reasonable suspicion about a demo like Concord's is that it is four
// hardcoded pages talking to each other. This is the answer. The code below is
// yours, it runs on this origin, and the coordinator learns of it the same way
// it learns of anything -- a toolchange event and a declaration it has never
// seen before.
//
// Running arbitrary code here is safe in the way a scratchpad is safe: it is
// your code, in your tab, on an origin that holds nothing. What it cannot do is
// reach the coordinator or any other participant, because the browser will not
// let it.

import { participant, COORDINATOR } from '/kit/vendor.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&"']/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

const STARTER = `// A lounge pass. Hold one, then issue it or drop the hold.
concord({
  id: 'lounge',
  brand: { hue: 250, chroma: 0.02, face: 'mono' },
  title: 'Skyline Lounge',
  steps: {
    reserve: {
      tool: 'hold_pass',
      ttlSeconds: 600,
      properties: { guests: { type: 'number', description: 'How many' } },
      run: ({ guests }) => ({ ref: 'LP' + Date.now().toString(36).toUpperCase(), guests }),
    },
    confirm: {
      tool: 'issue_pass',
      run: ({ ref }) => ({ ref, issued: true }),
    },
    // Delete this step and run again. The coordinator can no longer promise
    // to take this back, so the guarantee it offers drops.
    cancel: {
      tool: 'drop_hold',
      run: ({ ref }) => ({ ref, released: true }),
    },
  },
});`;

$('code').value = STARTER;
$('origin').textContent = location.origin;

const state = { passes: [], held: [] };
let revoke = null;

function status(kind, text) {
  $('live').className = kind;
  $('live').textContent = text;
}

/**
 * What a participant has to declare, expressed as plainly as it can be.
 *
 * Each step names the tool it registers and the function that runs. Everything
 * else -- the protocol declaration, idempotency, the status probe, signing --
 * comes from the kit, which is the point: joining should be a declaration, not
 * an integration.
 */
async function concord({ id, title, steps }) {
  if (!id || !steps) throw new Error('a participant needs an id and at least one step');

  const controller = new AbortController();
  const protocol = { steps: Object.fromEntries(Object.entries(steps).map(([phase, s]) =>
    [phase, { tool: s.tool, ...(s.ttlSeconds && { ttlSeconds: s.ttlSeconds }) }])) };

  const wired = Object.fromEntries(Object.entries(steps).map(([phase, s]) => [phase, {
    tool: s.tool,
    title: s.title ?? s.tool,
    description: s.description ?? `${phase} on ${title ?? id}`,
    properties: { ...(s.properties ?? {}), ...(phase === 'reserve' || phase === 'execute'
      ? {} : { ref: { type: 'string', description: 'Reference from the earlier step' } }) },
    tone: phase === 'reserve' ? 'hold' : 'ok',
    async run(args) {
      const out = await s.run(args) ?? {};
      const ref = out.ref ?? args.ref ?? null;
      if (phase === 'reserve') state.held.push({ ref, phase });
      if (phase === 'confirm') { state.held = state.held.filter((h) => h.ref !== ref); state.passes.push({ ref }); }
      if (phase === 'cancel' || phase === 'compensate') state.held = state.held.filter((h) => h.ref !== ref);
      return out;
    },
    summary: (a, r) => `${r.ref ?? ''} · ${phase}`,
  }]));

  await participant({
    id, title: title ?? id, protocol, steps: wired, state,
    signal: controller.signal,
    render: (s) => (s.held.length || s.passes.length
      ? [...s.held.map((h) => `<div class="row"><span>${esc(h.ref)}</span><span class="pill held">held</span></div>`),
         ...s.passes.map((p) => `<div class="row"><span>${esc(p.ref)}</span><span class="pill done">issued</span></div>`)].join('')
      : '<div class="empty">nothing yet</div>'),
  });

  revoke = () => controller.abort();
  const rungs = { 3: 'reservable', 2: 'compensable', 1: 'irreversible' };
  const has = (k) => Boolean(steps[k]);
  const rung = has('reserve') && has('confirm') && has('cancel') ? 3
    : has('execute') && has('compensate') ? 2 : has('execute') ? 1 : 0;
  $('rung').textContent = rungs[rung] ?? 'not a commitment protocol';
  $('rung').className = `rung ${rungs[rung] ?? ''}`;
  status('on', `${id} registered · ${rungs[rung] ?? 'unusable'}`);
}

async function run() {
  // Withdraw first: registering a name twice throws, and a page that redefines
  // itself has to take the old surface back before offering a new one.
  revoke?.(); revoke = null;
  await new Promise((r) => setTimeout(r, 60));
  state.held = []; state.passes = [];

  try {
    // eslint-disable-next-line no-new-func
    await new Function('concord', `return (async () => { ${$('code').value} })()`)(concord);
  } catch (err) {
    status('err', `did not run: ${err.message}`);
    $('rung').textContent = 'nothing registered';
    $('rung').className = 'rung';
  }
}

// The same buttons, drivable by the coordinator that embeds this page, so the
// demonstration can be scripted as well as clicked. Only that origin: this is a
// control channel like any other.
addEventListener('message', (e) => {
  if (e.origin !== COORDINATOR) return;
  if (e.data === '__drop_cancel__') { $('drop').click(); $('run').click(); }
  if (e.data === '__restore__') { $('code').value = STARTER; $('run').click(); }
  if (e.data === '__withdraw__') $('withdraw').click();
});

$('run').addEventListener('click', run);
$('withdraw').addEventListener('click', () => {
  revoke?.(); revoke = null;
  status('off', 'withdrawn');
  $('rung').textContent = 'nothing registered';
  $('rung').className = 'rung';
});
$('drop').addEventListener('click', () => {
  const code = $('code').value;
  $('code').value = code.includes('cancel:')
    ? code.replace(/\n\s*\/\/ Delete this step[\s\S]*?\n\s*cancel:\s*\{[\s\S]*?\n\s*\},\n/, '\n')
        .replace(/\n\s*cancel:\s*\{[\s\S]*?\n\s*\},\n/, '\n')
    : STARTER;
  $('drop').textContent = code.includes('cancel:') ? 'Put the cancel step back' : 'Delete the cancel step';
});

await run();
