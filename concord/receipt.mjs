// The receipt.
//
// After a multi-vendor commitment each party knows only its own half. Northwind
// knows it ticketed a seat; Rowan House knows it charged and refunded. Neither
// knows what happened elsewhere, and neither has any reason to trust the
// coordinator's account of it -- the coordinator is the traveller's agent, not
// a neutral party, and it is the one entity with a motive to misreport.
//
// So the receipt is not the coordinator's story. It is a Merkle tree over
// statements each vendor signed about itself. The coordinator can order those
// statements and prove the ordering, and it cannot forge one, because it never
// holds a vendor's key.
//
// The tree matters for a commercial reason as much as a cryptographic one. A
// vendor can verify its own entry belongs to the receipt through an inclusion
// proof made of hashes, without being shown what anyone else charged. Airlines
// do not want hotels to see their fares, and a receipt that forces disclosure
// to be verifiable would not be used.

import { canonical, sha256 } from '../kit/canonical.mjs';

/**
 * A leaf commits to the statement, not to the signature over it.
 *
 * Hashing both collapses two different accusations into one. If the tree covers
 * the signature bytes, swapping a signature reports "the entries do not hash to
 * the stated root" -- the record was altered -- when what actually happened is
 * that a statement is present which this vendor never made. Keeping the
 * signature outside the leaf separates them: a changed statement breaks
 * inclusion, a bad signature reports included but unsigned, and the receipt can
 * say which party is being accused of what.
 */
export async function leafHash(entry) {
  return sha256(`leaf:${canonical(entry.statement ?? entry)}`);
}

const nodeHash = (a, b) => sha256(`node:${a}${b}`);

/**
 * Build the tree, keeping every level so proofs can be cut later.
 *
 * An odd node is promoted to the next level rather than hashed with a copy of
 * itself. Duplicating is the common shortcut and it makes two different leaf
 * sets produce one root, which turns an inclusion proof into a forgery.
 */
export async function buildTree(leaves) {
  if (!leaves.length) throw new Error('a receipt needs at least one entry');
  const levels = [leaves];
  let level = leaves;

  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? await nodeHash(level[i], level[i + 1]) : level[i]);
    }
    levels.push(next);
    level = next;
  }
  return { root: level[0], levels };
}

/** The sibling hashes needed to walk one leaf up to the root. */
export function proofFor(levels, index) {
  const proof = [];
  let i = index;
  for (let depth = 0; depth < levels.length - 1; depth++) {
    const level = levels[depth];
    const isRight = i % 2 === 1;
    const sibling = isRight ? level[i - 1] : level[i + 1];
    // No sibling means this node was promoted, so nothing is combined here.
    if (sibling !== undefined) proof.push({ side: isRight ? 'left' : 'right', hash: sibling });
    i = Math.floor(i / 2);
  }
  return proof;
}

export async function verifyInclusion(leaf, proof, root) {
  let acc = leaf;
  for (const { side, hash } of proof) {
    acc = side === 'left' ? await nodeHash(hash, acc) : await nodeHash(acc, hash);
  }
  return acc === root;
}

// ── vendor statements ───────────────────────────────────────────────────────

/**
 * Exactly what a vendor puts its name to. Nothing here is the coordinator's.
 *
 * origin and parties are the two fields that make the receipt stand on its own:
 * the first anchors the key to the party, the second makes an omission visible.
 */
export function statement({ sagaId, origin, vendor, parties = [], step, idempotencyKey, result, at }) {
  return { sagaId, origin, vendor, parties: [...parties].sort(), step, idempotencyKey, at, result };
}

export async function importVerifyKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

/**
 * Fetch a vendor's published keys from its own origin.
 *
 * This is the anchor. Nothing in the receipt asserts who a key belongs to; the
 * verifier goes and asks the vendor, over the same transport that already
 * proves which origin it is talking to.
 */
export async function fetchKeys(origin) {
  const res = await fetch(`${origin}/.well-known/concord.json`, { redirect: 'error' });
  if (!res.ok) throw new Error(`${origin} publishes no concord key document`);
  const doc = await res.json();
  if (!Array.isArray(doc?.keys)) throw new Error(`${origin} published a malformed key document`);
  // The whole key record, not just the material: when a key was valid, and
  // whether it has since been retired or reported stolen, decides whether a
  // signature made with it means anything.
  return { vendor: doc.vendor, keys: Object.fromEntries(doc.keys.map((k) => [k.keyId, k])) };
}

/**
 * Default resolver: ask the origin the statement itself names.
 *
 * It also checks that the origin claims to be the vendor the statement says it
 * is. TLS proves you reached the origin you asked for; only the origin's own
 * document proves that origin is the party being named.
 */
export function originResolver() {
  const cache = new Map();
  return async function resolve(vendor, origin, keyId) {
    // A rejected promise used to be cached forever, so one transient failure
    // poisoned that origin for the life of the verifier.
    if (!cache.has(origin)) {
      cache.set(origin, fetchKeys(origin).catch((err) => { cache.delete(origin); throw err; }));
    }
    const doc = await cache.get(origin);
    if (doc.vendor !== vendor) {
      throw new Error(`${origin} identifies itself as "${doc.vendor}", not "${vendor}"`);
    }
    return doc.keys[keyId] ?? null;
  };
}

/**
 * Was this key entitled to speak at the moment the statement claims?
 *
 * A signature that verifies is not the same as a signature that counts. A key
 * retired last March cannot have signed something dated this June, and one its
 * owner has reported stolen since April says nothing about anything after that
 * -- however cleanly the maths checks out.
 */
export function keyValidAt(record, when) {
  if (!record || typeof record !== 'object') return { ok: false, why: 'no key record' };
  const at = Date.parse(when ?? '');
  if (!Number.isFinite(at)) return { ok: false, why: 'the statement carries no usable timestamp' };

  if (record.notBefore && at < Date.parse(record.notBefore)) {
    return { ok: false, why: `the key did not exist until ${record.notBefore}` };
  }
  if (record.status === 'rotated' && record.retiredAt && at > Date.parse(record.retiredAt)) {
    return { ok: false, why: `the key was retired on ${record.retiredAt}, before this statement is dated` };
  }
  if (record.status === 'compromised') {
    const since = record.compromisedSince;
    if (!since || at >= Date.parse(since)) {
      return { ok: false, why: `${record.vendor ?? 'the vendor'} reports this key compromised`
        + (since ? ` since ${since}` : '') + ', so this signature proves nothing' };
    }
  }
  return { ok: true, why: null };
}

export async function verifyStatement(entry, record) {
  const jwk = record?.publicKey ?? record;
  if (!entry.signature || !jwk) return false;
  const key = await importVerifyKey(jwk);
  const bytes = new TextEncoder().encode(canonical(entry.statement));
  const sig = Uint8Array.from(atob(entry.signature), (c) => c.charCodeAt(0));
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, bytes);
}

// ── the receipt ─────────────────────────────────────────────────────────────

export async function buildReceipt({ sagaId, outcome, entries, vendors }) {
  const leaves = await Promise.all(entries.map(leafHash));
  const { root, levels } = await buildTree(leaves);
  return {
    version: 1,
    sagaId,
    outcome,
    root,
    at: new Date().toISOString(),
    entries,
    // Where to go and ask, not what to believe. A receipt read years from now
    // resolves keys the same way: fetch them from the vendor that made the
    // statement, and let the origin do the vouching.
    vendors,
    proofs: entries.map((_, i) => proofFor(levels, i)),
  };
}

/**
 * Verify the whole receipt: every statement signed by the vendor that made it,
 * and every entry provably part of this root.
 */
export async function verifyReceipt(receipt, resolve = originResolver()) {
  const findings = [];
  const complaints = [];
  const entries = receipt.entries ?? [];
  if (!entries.length) return { ok: false, findings: [{ ok: false, why: 'the receipt contains no statements' }] };

  const leaves = await Promise.all(entries.map(leafHash));
  const { root } = await buildTree(leaves);
  if (root !== receipt.root) {
    // Still report per entry below, so the reader learns which one moved rather
    // than only that something did.
    complaints.push('the entries do not hash to the stated root');
  }

  // ── the receipt is one commitment, not a scrapbook ──────────────────────
  // Nothing used to bind a statement to this saga, so a coordinator could
  // stitch signed statements from unrelated transactions into one receipt and
  // assert any outcome over them.
  for (const entry of entries) {
    if (entry.statement?.sagaId !== receipt.sagaId) {
      complaints.push(`a statement from commitment "${entry.statement?.sagaId}" appears in a receipt for "${receipt.sagaId}"`);
      break;
    }
  }

  // ── nobody was left out ─────────────────────────────────────────────────
  // Each vendor signed the full party list, so dropping an inconvenient
  // statement leaves the survivors testifying that something is missing.
  const declared = entries.map((e) => (e.statement?.parties ?? []).join(','));
  if (new Set(declared).size > 1) {
    complaints.push('the statements disagree about who was party to this commitment');
  } else if (declared[0]) {
    const present = new Set(entries.map((e) => e.statement.vendor));
    const missing = declared[0].split(',').filter((v) => v && !present.has(v));
    if (missing.length) complaints.push(`no statement from ${missing.join(', ')}, who every other vendor names as party to this`);
  }

  for (const [i, entry] of entries.entries()) {
    const { vendor, origin } = entry.statement ?? {};
    const included = await verifyInclusion(leaves[i], receipt.proofs?.[i] ?? [], receipt.root);

    let jwk = null, why = null;
    try {
      // Resolved from the origin inside the signed statement. Never from
      // receipt.vendors, which the coordinator writes and the accused party
      // does not: that map let a coordinator name its own origin as the airline
      // and have its own signature verify.
      if (!origin) why = 'the statement names no origin, so its key cannot be resolved';
      else {
        jwk = await resolve(vendor, origin, entry.keyId);
        if (!jwk) why = `${origin} publishes no key ${entry.keyId}`;
      }
    } catch (err) { why = err.message; }

    let signed = jwk ? await verifyStatement(entry, jwk) : false;

    // A key that verifies but was not entitled to sign at that moment is worse
    // than no signature, because it looks like one.
    let inForce = true;
    if (signed && jwk?.publicKey) {
      const window = keyValidAt({ ...jwk, vendor }, entry.statement?.at);
      if (!window.ok) { inForce = false; signed = false; why = window.why; }
    }

    findings.push({
      index: i, vendor, origin, step: entry.statement?.step, keyId: entry.keyId,
      included, signed, inForce, ok: included && signed, ...(why && { why }),
    });
  }

  return {
    ok: complaints.length === 0 && findings.every((f) => f.ok),
    root, findings, complaints,
  };
}

/**
 * What a single vendor checks, holding only its own entry, its proof, and the
 * root. It learns nothing about the others -- the proof is opaque hashes.
 */
export async function verifyOwnEntry({ entry, proof, root, jwk }) {
  const included = await verifyInclusion(await leafHash(entry), proof, root);
  const signed = await verifyStatement(entry, jwk);
  return { ok: included && signed, included, signed };
}
