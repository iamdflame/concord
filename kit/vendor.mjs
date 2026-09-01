// Shared machinery for a Concord participant.
//
// A vendor's job in this protocol is small but exacting: declare honestly what
// it can commit to, never do the same work twice for the same idempotency key,
// and be breakable on purpose so the coordinator can be tested against real
// failure rather than a simulation of it.

import { resolveModelContext } from '/shim/adapter.mjs';
import { canonical } from '/kit/canonical.mjs';

export const COORDINATOR = 'http://localhost:5173';

/** Every commitment step declares these. Neither is smuggled in. */
export const KEY_PARAM = {
  idempotencyKey: { type: 'string', description: 'Stable key for this step; a repeat returns the first result' },
  sagaId: { type: 'string', description: 'The commitment this step belongs to; it is covered by the signature' },
};

export async function participant({ id, title, protocol, steps, state, render }) {
  const { ctx } = await resolveModelContext();
  const seen = new Map();     // idempotency key -> the answer we already gave
  const failing = new Set();  // steps the operator has broken on purpose

  // The signing key belongs to this vendor's server and is published at
  // /.well-known/concord.json on this origin. The page never holds it. That is
  // what makes a receipt outlive the tab that produced it, and what binds the
  // key to the party -- a verifier fetches it from the vendor over TLS rather
  // than being handed it alongside the claim it is meant to authenticate.
  const published = await (await fetch('/.well-known/concord.json')).json();
  const keyId = published.keys.find((k) => k.status === 'active').keyId;

  async function attest(step, args, result) {
    const statement = {
      sagaId: args.sagaId ?? null, vendor: id, step,
      idempotencyKey: args.idempotencyKey, result,
    };
    const signed = await (await fetch('/_concord/sign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement }),
    })).json();
    return { statement, keyId: signed.keyId, signature: signed.signature };
  }

  // The commitment surface. WebMCP says what a tool is, not what it promises,
  // so this declaration is the only thing the coordinator trusts about us.
  await ctx.registerTool({
    name: 'concord.protocol',
    title: 'Declare commitment protocol',
    description: `How ${id} can take part in a multi-vendor commitment: which tools reserve, `
      + 'confirm, cancel, execute or compensate, and whether anything here can be undone.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    // Declare where the key lives, not the key. Carrying the key here would
    // put it on the same channel as the claim, which anchors nothing.
    async execute() { return { id, title, keyId, origin: location.origin, ...protocol }; },
  }, { exposedTo: [COORDINATOR] });

  for (const [step, spec] of Object.entries(steps)) {
    await ctx.registerTool({
      name: spec.tool,
      title: spec.title,
      description: spec.description,
      inputSchema: {
        type: 'object',
        properties: { ...KEY_PARAM, ...(spec.properties ?? {}) },
        required: ['idempotencyKey', ...(spec.required ?? [])],
      },
      annotations: { readOnlyHint: false },
      async execute(args) {
        // Replay before anything else. A retried confirm must not double-book,
        // and the coordinator retries on purpose.
        if (seen.has(args.idempotencyKey)) {
          const prior = seen.get(args.idempotencyKey);
          log(`${step} replayed`, `key ${args.idempotencyKey.slice(-14)} — returning the first answer`);
          return { ...prior, replayed: true };
        }
        if (failing.has(step)) {
          log(`${step} refused`, 'broken on purpose by the operator', 'bad');
          throw new Error(`${id} cannot ${step} right now`);
        }
        const result = await spec.run(args);
        // Sign the bare result, so what the vendor puts its name to is exactly
        // what it did -- not the envelope the coordinator later wraps it in.
        const signed = { ...result, attestation: await attest(step, args, result) };
        seen.set(args.idempotencyKey, signed);
        log(`${step}`, spec.summary?.(args, result) ?? '', spec.tone ?? 'ok');
        paint();
        return signed;
      },
    }, { exposedTo: [COORDINATOR] });
  }

  // ── operator surface: the switches a judge is invited to flip ─────────────
  const switches = document.getElementById('switches');
  if (switches) {
    switches.innerHTML = Object.keys(steps).map((step) =>
      `<label class="sw"><input type="checkbox" data-step="${step}"> break ${step}</label>`).join('');
    switches.addEventListener('change', (e) => {
      const step = e.target.dataset.step;
      e.target.checked ? failing.add(step) : failing.delete(step);
      document.body.classList.toggle('broken', failing.size > 0);
    });
  }

  // The same switch a person flips, drivable from the embedding page so the
  // integration suite can break a vendor mid-transaction the way a judge would.
  addEventListener('message', (e) => {
    const order = e.data?.__concord_break__;
    if (!order || !steps[order.step]) return;
    order.on ? failing.add(order.step) : failing.delete(order.step);
    const box = switches?.querySelector(`[data-step="${order.step}"]`);
    if (box) box.checked = order.on;
    document.body.classList.toggle('broken', failing.size > 0);
  });

  const feed = document.getElementById('feed');
  function log(what, detail, tone = 'ok') {
    if (!feed) return;
    if (feed.querySelector('.empty')) feed.innerHTML = '';
    feed.insertAdjacentHTML('afterbegin',
      `<div class="ev ${tone}"><b>${what}</b><span>${String(detail).replace(/[<&]/g, '')}</span></div>`);
  }
  function paint() {
    const el = document.getElementById('state');
    if (el && render) el.innerHTML = render(state);
  }

  paint();
  document.getElementById('origin').textContent = location.origin;
  return { log, paint };
}
