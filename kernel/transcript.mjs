// The transcript: an append-only, hash-chained record of every decision the
// kernel made, and enough of the inputs to derive the rest.
//
// It deliberately does not store snapshots of kernel state. State at any
// instant is *recomputed* by replaying the recorded tool outputs through the
// same Provenance the live kernel used. That distinction is the difference
// between a reconstruction and an animation, and it is checkable: replaying to
// step n must produce exactly the labels the live kernel held at step n.
//
// Each entry carries the digest of the one before it, so an entry cannot be
// edited, reordered or removed without breaking every link after it.

import { Label, Provenance } from './labels.mjs';

/** Stable serialisation -- key order must not change a digest. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function digest(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(buf).slice(0, 16);
}

export class Transcript {
  #entries = [];

  get entries() { return this.#entries; }
  get length() { return this.#entries.length; }
  at(i) { return this.#entries[i]; }

  async append(entry) {
    const prev = this.#entries.at(-1)?.hash ?? '0'.repeat(16);
    const body = { seq: this.#entries.length, ...entry, prev };
    const record = { ...body, hash: await digest(canonical(body)) };
    this.#entries.push(record);
    return record;
  }

  /** Recompute every digest and confirm the chain still links. */
  async verify() {
    let prev = '0'.repeat(16);
    for (const entry of this.#entries) {
      const { hash, ...body } = entry;
      if (body.prev !== prev) return { ok: false, brokenAt: entry.seq, why: 'chain link' };
      if (await digest(canonical(body)) !== hash) return { ok: false, brokenAt: entry.seq, why: 'content digest' };
      prev = hash;
    }
    return { ok: true, brokenAt: null, why: null };
  }
}

/**
 * Rebuild the whole system as it stood immediately after `upTo`.
 *
 * Nothing here reads a stored snapshot. Labels come back by replaying the same
 * observations through a fresh Provenance, which is why scrubbing the timeline
 * shows what actually held at that moment rather than a recording of it.
 */
export function reconstruct(entries, upTo) {
  const provenance = new Provenance();
  const settled = [];
  const denials = [];
  const origins = new Map();
  let pending = null;

  for (const entry of entries.slice(0, upTo + 1)) {
    const origin = entry.toolId.replace(/\/[^/]+$/, '');
    const stat = origins.get(origin) ?? { calls: 0, denied: 0, tainted: false };
    stat.calls += 1;

    if (entry.kind === 'deny') {
      stat.denied += 1;
      denials.push(entry);
    } else {
      const label = Label.of(...(entry.labelTags ?? []));
      provenance.observe(entry.result, label, entry.toolId);
      if (label.has('UNTRUSTED')) stat.tainted = true;
      if (entry.egress !== 'none') settled.push(entry);
    }
    origins.set(origin, stat);
    pending = entry;
  }

  return {
    at: upTo,
    context: provenance.context,
    provenance,
    settled,
    denials,
    origins,
    last: pending,
  };
}
