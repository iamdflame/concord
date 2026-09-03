// Shared machinery for a Concord participant.
//
// A vendor's job in this protocol is small but exacting: declare honestly what
// it can commit to, never do the same work twice for the same idempotency key,
// and be breakable on purpose so the coordinator can be tested against real
// failure rather than a simulation of it.

import { resolveModelContext } from '/shim/adapter.mjs';
import { canonical } from '/kit/canonical.mjs';
import { COORDINATOR } from '/config.mjs';

export { COORDINATOR };

/**
 * Enforce a tool's own published schema before it runs.
 *
 * A declared inputSchema that nothing checks is a claim about what a tool
 * accepts rather than a fact about it -- and this is a surface an untrusted
 * agent drives, so "it will send what it said it would" is not a premise
 * anybody should rely on. It is also the shortest path to keeping attacker
 * strings out of a page that renders them.
 */
export function validate(schema, args, toolName) {
  if (!schema || schema.type !== 'object') return;
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) throw new Error(`${toolName}: "${key}" is required`);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties?.[key];
    if (!spec || value === undefined) continue;

    const want = spec.type === 'integer' ? 'number' : spec.type;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (want && actual !== want) {
      throw new Error(`${toolName}: "${key}" must be ${spec.type}, got ${actual}`);
    }
    if (spec.type === 'integer' && !Number.isInteger(value)) {
      throw new Error(`${toolName}: "${key}" must be a whole number`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`${toolName}: "${key}" must be a finite number`);
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw new Error(`${toolName}: "${key}" must be one of ${spec.enum.join(', ')}`);
    }
    // A bound on strings, because everything here ends up rendered somewhere.
    if (typeof value === 'string' && value.length > (spec.maxLength ?? 512)) {
      throw new Error(`${toolName}: "${key}" is longer than ${spec.maxLength ?? 512} characters`);
    }
  }
}

/** Tool arguments are attacker-controlled from this origin's point of view. */
export const esc = (s) => String(s).replace(/[<>&"']/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));


/** Every commitment step declares these. None of them is smuggled in. */
export const KEY_PARAM = {
  idempotencyKey: { type: 'string', description: 'Stable key for this step; a repeat returns the first result' },
  sagaId: { type: 'string', description: 'The commitment this step belongs to; it is covered by the signature' },
  parties: {
    type: 'array', items: { type: 'string' },
    description: 'Every vendor in this commitment',
  },
  plan: {
    type: 'object',
    description: 'The shape of the whole commitment — who is party to it, what guarantee was '
      + 'computed, and every step it consists of. Signed, so no statement can be quietly '
      + 'dropped from the receipt afterwards',
  },
};

/**
 * Join a commitment as a participant.
 *
 * `signal` revokes every registration at once, which is what lets a page
 * redefine itself without reloading: registering a name twice throws, so
 * re-running has to withdraw the previous surface first.
 *
 * The DOM hooks are optional. A participant with no visible state is still a
 * participant.
 */
/**
 * How a participant looks like itself.
 *
 * Six businesses that have never met should not be six copies of one template.
 * A hue and a lettering are enough: an airline is not set in the same face as a
 * consulate, and being able to tell them apart at a glance is the difference
 * between "five instances of a demo" and "five strangers with different
 * interests", which is the entire premise.
 */
const FACES = {
  mono:    { face: 'ui-monospace, Menlo, Consolas, monospace', tracking: '.18em', transform: 'uppercase', weight: '600' },
  airline: { face: 'ui-monospace, Menlo, Consolas, monospace', tracking: '.34em', transform: 'uppercase', weight: '400' },
  house:   { face: 'Georgia, "Times New Roman", serif',        tracking: '.01em', transform: 'none',      weight: '600' },
  state:   { face: 'Georgia, "Times New Roman", serif',        tracking: '.16em', transform: 'uppercase', weight: '400' },
  finance: { face: 'system-ui, -apple-system, sans-serif',     tracking: '-.01em', transform: 'none',     weight: '600' },
};

function wear(brand = {}) {
  const f = FACES[brand.face] ?? FACES.mono;
  const root = document.documentElement.style;
  root.setProperty('--brand-hue', String(brand.hue ?? 250));
  root.setProperty('--brand-chroma', String(brand.chroma ?? 0.09));
  root.setProperty('--brand-face', f.face);
  root.setProperty('--brand-tracking', f.tracking);
  root.setProperty('--brand-transform', f.transform);
  root.setProperty('--brand-weight', f.weight);
}

export async function participant({ id, title, protocol, steps, state, render, brand, signal }) {
  wear(brand);
  const { ctx } = await resolveModelContext();

  // What this vendor has already honoured, and what it answered.
  //
  // This was in memory, so reloading the page made concord.status start
  // answering "never happened" for steps that genuinely did -- and by the
  // coordinator's own reasoning, believing that strands the charge. It is the
  // ground truth recovery is built on, so it outlives the page.
  const STORE = `concord.seen.${id}`;
  const seen = new Map(Object.entries((() => {
    try { return JSON.parse(localStorage.getItem(STORE) ?? '{}'); } catch { return {}; }
  })()));
  // And what it actually did.
  //
  // Persisting `seen` and not the books was half a fix, and the half that was
  // missing produced the worst answer a participant can give. After a reload
  // this vendor would tell a recovering coordinator "yes, RH7FBCD8C happened"
  // -- correctly, from the line above -- and then refuse to cancel it with "no
  // booking RH7FBCD8C", because the booking itself had only ever been in
  // memory. A party that remembers *that* it took your money and has forgotten
  // *what it took* is worse than one that has forgotten both: the first answer
  // stops the coordinator from writing it off, and the second stops anyone
  // from getting it back.
  //
  // A real participant has a database and this is not a question. These
  // participants are pages, so their books live where their memory of the
  // step lives, and are written in the same breath.
  // A participant writes its state the way it wants to; the kit carries it,
  // rather than the kit dictating what a participant may hold. Northwind Air
  // keeps its holds in a Map, and a plain JSON round trip silently replaced it
  // with {} -- so the vendor came back from a reload, was asked to release a
  // hold, and answered "state.holds.delete is not a function". Storage that
  // corrupts what it is given is worse than no storage, because the failure
  // arrives during recovery.
  const BOOKS = `concord.state.${id}`;
  const pack = (_k, v) => (v instanceof Map ? { __map: [...v] }
    : v instanceof Set ? { __set: [...v] } : v);
  const unpack = (_k, v) => (v && typeof v === 'object'
    ? (Array.isArray(v.__map) ? new Map(v.__map)
      : Array.isArray(v.__set) ? new Set(v.__set) : v)
    : v);

  if (state) {
    try {
      const saved = JSON.parse(localStorage.getItem(BOOKS) ?? 'null', unpack);
      // Mutated in place: the vendor's own closures hold this exact object.
      if (saved && typeof saved === 'object') Object.assign(state, saved);
    } catch { /* unreadable: start empty, and say so by simply being empty */ }
  }
  const record = () => {
    if (!state) return;
    try { localStorage.setItem(BOOKS, JSON.stringify(state, pack)); }
    catch { /* full or blocked */ }
  };

  const remember = (key, value) => {
    seen.set(key, value);
    try { localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(seen))); }
    catch { /* full or blocked: the in-memory map still serves this session */ }
    // Both, together. Whatever separates them is a window in which this
    // participant's two answers disagree.
    record();
  };

  const failing = new Set();  // steps the operator has broken on purpose

  // The signing key belongs to this vendor's server and is published at
  // /.well-known/concord.json on this origin. The page never holds it. That is
  // what makes a receipt outlive the tab that produced it, and what binds the
  // key to the party -- a verifier fetches it from the vendor over TLS rather
  // than being handed it alongside the claim it is meant to authenticate.
  const published = await (await fetch('/.well-known/concord.json')).json();
  // A participant that has retired or reported its key has no active one. That
  // is a safety declaration, and it must not be the thing that takes the page
  // down -- reading .keyId off undefined threw at module load, so revoking a
  // key disabled the participant entirely.
  const active = published.keys?.find((k) => k.status === 'active');
  const keyId = active?.keyId ?? null;
  if (!keyId) {
    console.warn(`[concord] ${id} publishes no active key, so it will act but not attest. `
      + 'Statements it makes cannot be verified until a key is published.');
  }

  async function attest(step, args, result) {
    const statement = {
      sagaId: args.sagaId ?? null,
      // The vendor's own origin, inside what it signs. A verifier resolves the
      // key from here rather than from a name-to-origin map the coordinator
      // wrote -- that map let a coordinator point "fly" at an origin it
      // controlled and have its own signature verify as the airline's.
      origin: location.origin,
      vendor: id,
      parties: [...(args.parties ?? [])].sort(),
      // The shape of the whole commitment, not just this vendor's part of it.
      // Attesting only to its own part let a coordinator drop one statement and
      // rebuild the receipt around the rest; attesting to the whole means the
      // survivors testify that something is missing.
      plan: args.plan ?? null,
      step,
      idempotencyKey: args.idempotencyKey,
      at: new Date().toISOString(),
      result,
    };
    const signed = await (await fetch('/_concord/sign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement }),
    })).json();
    return { statement, keyId: signed.keyId, signature: signed.signature };
  }

  // Every Concord vendor is recoverable by construction. The kit already knows
  // which idempotency keys it has honoured, so it can answer the one question a
  // coordinator needs after a crash -- did this ever happen -- without
  // performing anything. A vendor that could not answer it would leave the
  // coordinator guessing, and guessing is how money gets stranded twice.
  await ctx.registerTool({
    name: 'concord.status',
    title: 'Was this step ever performed?',
    description: 'Given an idempotency key, reports whether that step was carried out, and what it '
      + 'returned. Performs nothing. Used to resolve a commitment interrupted mid-flight.',
    inputSchema: {
      type: 'object',
      // Deliberately not called idempotencyKey. Every commitment step declares
      // one of those for its own call, and a probe that reused the name had the
      // key it was asking about overwritten by the key of the asking -- so the
      // lookup always missed and recovery quietly found nothing.
      properties: { lookupKey: { type: 'string', description: 'The idempotency key to look up' } },
      required: ['lookupKey'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        lookupKey: { type: 'string' },
        happened: { type: 'boolean',
          description: 'Whether this participant ever honoured that key. Its own record, not a guess.' },
        result: { type: ['object', 'null'] },
      },
      required: ['lookupKey', 'happened'],
    },
    annotations: { readOnlyHint: true },
    async execute({ lookupKey }) {
      const prior = seen.get(lookupKey);
      return { lookupKey, happened: Boolean(prior), result: prior ?? null };
    },
  }, { exposedTo: [COORDINATOR], signal });

  // The commitment surface. WebMCP says what a tool is, not what it promises,
  // so this declaration is the only thing the coordinator trusts about us.
  await ctx.registerTool({
    name: 'concord.protocol',
    title: 'Declare commitment protocol',
    description: `How ${id} can take part in a multi-vendor commitment: which tools reserve, `
      + 'confirm, cancel, execute or compensate, and whether anything here can be undone.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, title: { type: 'string' }, origin: { type: 'string' },
        keyId: { type: ['string', 'null'],
          description: 'Which published key signs this participant\'s statements.' },
        steps: { type: 'object',
          description: 'phase -> { tool, ttlSeconds?, refund? }. The phases present are what '
            + 'this participant can commit to, and the whole guarantee is derived from them.' },
        irreversible: { type: 'boolean' },
        note: { type: ['string', 'null'] },
      },
      required: ['id', 'origin', 'steps'],
    },
    annotations: { readOnlyHint: true },
    // Declare where the key lives, not the key. Carrying the key here would
    // put it on the same channel as the claim, which anchors nothing.
    async execute() {
      return {
        id, title, keyId, origin: location.origin, ...protocol,
        steps: { ...protocol.steps, status: { tool: 'concord.status' },
                 nothing: { tool: 'concord.attest_nothing' } },
      };
    },
  }, { exposedTo: [COORDINATOR], signal });

  // ── attesting to having done nothing ──────────────────────────────────────
  //
  // Silence in a receipt is unreadable: a participant that never acted and a
  // participant whose statement was deleted look exactly alike, so a verifier
  // that treats absence as evidence of absence can be robbed by deletion. The
  // fix is that not acting is also a thing you sign.
  //
  // This refuses if the participant did act. That refusal is what makes the
  // signature worth anything -- "I did nothing" from a party that cannot tell
  // is not a statement, it is a formality -- and the participant is the only
  // one who can check, because it is the only one holding the record.
  await mc.registerTool({
    name: 'concord.attest_nothing',
    title: 'Sign that this participant did nothing in a commitment',
    description: 'For a commitment this participant was named in but performed no step of, '
      + 'returns a signed statement saying so, so that its silence in the receipt is provable '
      + 'rather than merely absent. Performs nothing, and refuses if this participant did act.',
    inputSchema: {
      type: 'object',
      properties: {
        sagaId: { type: 'string', description: 'The commitment it took no part in' },
        parties: { type: 'array', items: { type: 'string' }, description: 'Every party to it' },
        plan: { type: 'object', description: 'The shape of the whole commitment' },
      },
      required: ['sagaId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        attestation: { type: 'object',
          description: 'A signed statement that this participant performed no step.' },
        error: { type: 'string', description: 'Present if it did act, and so will not sign.' },
      },
    },
    annotations: { readOnlyHint: true },
    async execute({ sagaId, parties = [], plan = null }) {
      const acted = [...seen.keys()].some((k) => String(k).startsWith(`${sagaId}.`));
      if (acted) {
        return { error: `${id} did act in ${sagaId}, so it will not sign that it did not`,
                 terminal: true };
      }
      const args = { sagaId, parties, plan, idempotencyKey: `${sagaId}.${id}.none` };
      return { attestation: await attest('none', args, { happened: false }) };
    },
  }, { exposedTo: [COORDINATOR], signal });

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
      // Every commitment step answers with the same envelope: a handle later
      // steps name, whatever the participant chose to return, and a signature
      // over exactly what it did. An agent can check the shape rather than
      // guess at it -- and the presence of `error` in the schema is the honest
      // statement that a business refusal is an answer, not a fault.
      outputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'The handle a later step names.' },
          attestation: { type: 'object',
            description: 'This participant\'s signature over what it just did.' },
          replayed: { type: 'boolean',
            description: 'True when this key was already honoured and the first answer is repeated.' },
          error: { type: 'string',
            description: 'A business refusal — no seats, no live hold. An answer, not a failure.' },
          terminal: { type: 'boolean', description: 'True when retrying cannot change the answer.' },
        },
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
          // Broken on purpose stands in for "cannot right now", which is a
          // transient condition. It throws, so the coordinator may retry it.
          log(`${step} refused`, 'broken on purpose by the operator', 'bad');
          throw new Error(`${id} cannot ${step} right now`);
        }

        let result;
        try {
          // The tool's own published schema, enforced. A refusal here is an
          // answer -- the arguments were wrong and will be wrong again.
          validate({ type: 'object', properties: { ...KEY_PARAM, ...(spec.properties ?? {}) },
                     required: ['idempotencyKey', ...(spec.required ?? [])] }, args, spec.tool);
          result = await spec.run(args);
        } catch (err) {
          // A business refusal is an answer: no seats left, no live hold. It is
          // returned rather than thrown, because retrying it cannot change it,
          // and a coordinator that cannot tell an answer from silence retries
          // decisions that were already final.
          log(`${step} declined`, err.message, 'bad');
          return { error: err.message, terminal: true };
        }
        // Sign the bare result, so what the vendor puts its name to is exactly
        // what it did -- not the envelope the coordinator later wraps it in.
        const signed = { ...result, attestation: await attest(step, args, result) };
        remember(args.idempotencyKey, signed);
        log(`${step}`, spec.summary?.(args, result) ?? '', spec.tone ?? 'ok');
        paint();
        return signed;
      },
    }, { exposedTo: [COORDINATOR], signal });
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
    // Only the coordinator embedding this page may flip these. Without the
    // check, any frame in the tab could force a vendor to fail and strand
    // money -- an unguarded control channel in a design whose whole premise is
    // mutually distrusting origins.
    if (e.origin !== COORDINATOR) return;

    // Books that survive a reload also survive a reset, which is not what a
    // reset is for. The coordinator cannot clear another origin's storage, so
    // it asks -- over the same channel, with the same origin check, and the
    // participant is the one that does it.
    // A *request*, not an instruction. The coordinator cannot restyle another
    // origin and should not be able to; what it can do is say which way it has
    // been set, and this participant may honour that or ignore it. Honouring it
    // keeps six embedded strangers from looking broken inside a page the reader
    // just switched to light -- and a participant that would rather keep its
    // own look simply does not listen for this.
    if (e.data?.__concord_theme__) {
      const want = e.data.__concord_theme__;
      if (want === 'light' || want === 'dark') document.documentElement.dataset.theme = want;
      else delete document.documentElement.dataset.theme;
      return;
    }

    if (e.data?.__concord_reset__) {
      try { localStorage.removeItem(STORE); localStorage.removeItem(BOOKS); } catch { /* blocked */ }
      location.reload();
      return;
    }

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
      `<div class="ev ${tone}"><b>${esc(what)}</b><span>${esc(detail)}</span></div>`);
  }
  function paint() {
    const el = document.getElementById('state');
    if (el && render) el.innerHTML = render(state);
  }

  paint();
  const originEl = document.getElementById('origin');
  if (originEl) originEl.textContent = location.origin;
  return { log, paint };
}
