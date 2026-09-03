// Generated from concord/receipt.mjs by verify/build.mjs. Do not edit here.
// The source of truth lives in the Concord repository:
//   https://github.com/iamdflame/concord

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

import { canonical, sha256 } from './canonical.mjs';

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
 * The largest power of two strictly less than n.
 *
 * RFC 6962's split. It makes the shape of the tree a function of the number of
 * leaves alone, which is what lets a proof be checked from an index and a size
 * rather than from side markers the prover chose.
 */
const split = (n) => 1 << (31 - Math.clz32(n - 1));

/** RFC 6962 §2.1 Merkle Tree Hash, over already-hashed leaves. */
async function mth(leaves) {
  if (leaves.length === 1) return leaves[0];
  const k = split(leaves.length);
  return nodeHash(await mth(leaves.slice(0, k)), await mth(leaves.slice(k)));
}

/**
 * The root of a receipt's statements.
 *
 * Two things are load-bearing here and one of them used to be described wrongly
 * in this comment.
 *
 * The first is **domain separation**: a leaf is hashed as `leaf:…` and an
 * interior node as `node:…`, so no leaf can ever equal an interior node and no
 * caller can pass a pre-computed subtree in as a leaf. That is what actually
 * stops a second leaf set producing the same root, and it is what the old
 * comment credited to promoting odd nodes instead of duplicating them.
 * Promotion is a fine thing to do and it is not the defence: buildTree(['a',
 * 'b', 'c']) and buildTree([node(a,b), 'c']) produced *identical roots*.
 *
 * The second is the **size commitment**. The root folds in the number of
 * leaves, so a tree of three and a tree of two cannot collide however their
 * interiors happen to line up. Without it, domain separation protects
 * buildReceipt -- whose leaves are always real leaf hashes -- and leaves this
 * function unsafe for anyone else who exports it.
 */
export async function buildTree(leaves) {
  if (!leaves.length) throw new Error('a receipt needs at least one entry');
  const inner = await mth(leaves);
  return { root: await sha256(`concord-v2:${leaves.length}:${inner}`), size: leaves.length, leaves };
}

/**
 * An audit path, committing to where in the tree it sits.
 *
 * The old proof was a list of siblings each carrying its own `side`, and it
 * named neither the index nor the size. A verifier could therefore be handed a
 * path that recomputed to the root while describing a position nobody occupied.
 * Index and size are now part of the proof and the sides are derived from them,
 * so a prover cannot choose them.
 */
export async function proofFor(leaves, index) {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new RangeError(`no leaf ${index} in a tree of ${leaves.length}`);
  }
  const path = [];
  const walk = async (list, i) => {
    if (list.length === 1) return;
    const k = split(list.length);
    if (i < k) { path.push(await mth(list.slice(k))); await walk(list.slice(0, k), i); }
    else { path.push(await mth(list.slice(0, k))); await walk(list.slice(k), i - k); }
  };
  await walk(leaves, index);
  return { index, size: leaves.length, path };
}

export async function verifyInclusion(leaf, proof, root) {
  const { index, size, path } = proof ?? {};
  if (!Number.isInteger(index) || !Number.isInteger(size)) return false;
  if (index < 0 || index >= size || !Array.isArray(path)) return false;

  // Walk down from the root deciding each turn from index and size, then fold
  // back up. A path longer or shorter than the position demands is a forged
  // one, so the length is checked rather than the loop simply running out.
  const steps = [];
  let i = index, n = size, p = 0;
  while (n > 1) {
    if (p >= path.length) return false;
    const k = split(n);
    if (i < k) { steps.push(['right', path[p++]]); n = k; }
    else { steps.push(['left', path[p++]]); i -= k; n -= k; }
  }
  if (p !== path.length) return false;

  let acc = leaf;
  for (const [side, hash] of steps.reverse()) {
    acc = side === 'left' ? await nodeHash(hash, acc) : await nodeHash(acc, hash);
  }
  return (await sha256(`concord-v2:${size}:${acc}`)) === root;
}

export function statement({ sagaId, origin, vendor, parties = [], plan = null,
                            step, idempotencyKey, result, at }) {
  return { sagaId, origin, vendor, parties: [...parties].sort(), plan, step, idempotencyKey, at, result };
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
export async function fetchKeys(origin, { timeoutMs = 10_000 } = {}) {
  // A participant that never answers must not hang the tool somebody is
  // running to settle a dispute with it.
  const res = await fetch(`${origin}/.well-known/concord.json`,
    { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
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
 * A key record, whatever shape the resolver handed back.
 *
 * verifyStatement has always accepted either a full record or a bare JWK, for
 * the convenience of callers holding one key. That convenience quietly
 * disabled every check that reads the record's metadata -- status, validity
 * window, algorithm -- because a bare JWK has none. Normalising here means the
 * checks run against a record that always has the fields, and a bare key is
 * treated as a key with no stated validity rather than a key with unlimited
 * validity.
 */
export function normaliseKeyRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.publicKey) return record;
  // A bare JWK. Wrapped, and deliberately not given a status: keyValidAt
  // decides what an unstated status means, in one place.
  if (record.kty) return { publicKey: record, keyId: record.kid ?? null, alg: record.alg ?? null };
  return null;
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
  if (record.status === 'rotated') {
    // A key declared retired with no date is retired as of now. Requiring both
    // meant "rotated" alone passed every statement, which is the opposite of
    // what declaring it means.
    if (!record.retiredAt) {
      return { ok: false, why: 'the key is declared retired with no date, so nothing can be placed inside its life' };
    }
    if (at > Date.parse(record.retiredAt)) {
      return { ok: false, why: `the key was retired on ${record.retiredAt}, before this statement is dated` };
    }
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
  // This runs on input supplied by whoever is being disputed with, so every
  // step of it is hostile-input handling. Malformed base64 or a malformed JWK
  // must be a failed signature, not a thrown exception that takes down the
  // verdict for every other party in the receipt.
  try {
    // The declared algorithm is checked rather than ignored: verifying an
    // ES256 signature against a key that says it is something else would be
    // accepting a claim nobody made.
    if (record?.alg && record.alg !== 'ES256') return false;
    if (jwk.kty !== 'EC' || (jwk.crv && jwk.crv !== 'P-256')) return false;

    const key = await importVerifyKey(jwk);
    const bytes = new TextEncoder().encode(canonical(entry.statement));
    const raw = atob(entry.signature);
    const sig = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    if (sig.length !== 64) return false;            // P-256 r‖s
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, bytes);
  } catch {
    return false;
  }
}

// ── the receipt ─────────────────────────────────────────────────────────────

export async function buildReceipt({ sagaId, outcome, entries, vendors }) {
  const leaves = await Promise.all(entries.map(leafHash));
  const { root } = await buildTree(leaves);
  return {
    // 2: the root commits to the number of statements, and each proof to its
    // own index. A version-1 receipt cannot be checked by this code, which is
    // the correct outcome -- its proofs assert less than these do.
    version: 2,
    sagaId,
    outcome,
    root,
    at: new Date().toISOString(),
    entries,
    // Where to go and ask, not what to believe. A receipt read years from now
    // resolves keys the same way: fetch them from the vendor that made the
    // statement, and let the origin do the vouching.
    vendors,
    proofs: await Promise.all(entries.map((_, i) => proofFor(leaves, i))),
  };
}

/**
 * Verify the whole receipt: every statement signed by the vendor that made it,
 * and every entry provably part of this root.
 */
/** The step a participant signs when it was party to a plan and did nothing. */
export const NOTHING = 'none';

const REVERSALS = new Set(['cancel', 'compensate']);

export const OUTCOME_COMMITTED = 'committed';
export const OUTCOMES = new Set(['committed', 'unwound', 'in-doubt', 'refused']);

/**
 * What these statements say happened, without asking the coordinator.
 *
 * The rules are the ones the executor itself follows, read backwards:
 *
 *   every planned step has a statement            -> committed
 *   nothing forward stands, because each forward
 *     step has a matching reversal                -> unwound
 *   nothing forward happened at all               -> refused
 *   otherwise                                     -> in-doubt
 *
 * "in-doubt" is the fallback on purpose. A receipt that cannot be shown to be
 * one of the clean outcomes is not thereby clean, and the honest thing to say
 * about evidence that does not add up is that it does not add up.
 */
export function deriveOutcome(plan, entries) {
  const steps = plan?.steps ?? [];
  const done = new Set(entries.map((e) => `${e.statement.vendor}.${e.statement.step}`));
  if (steps.length && steps.every((s) => done.has(s))) return OUTCOME_COMMITTED;

  const forward = entries.filter((e) =>
    !REVERSALS.has(e.statement.step) && e.statement.step !== NOTHING);
  if (!forward.length) return 'refused';

  // A forward effect is answered if the same vendor also has a reversal, or --
  // for a reservation -- if it was never confirmed and so never became a
  // booking. Anything left standing means something is outstanding.
  const reversed = new Set(entries.filter((e) => REVERSALS.has(e.statement.step))
    .map((e) => e.statement.vendor));
  const confirmed = new Set(entries.filter((e) => e.statement.step === 'confirm')
    .map((e) => e.statement.vendor));
  const standing = forward.filter((e) => {
    const { vendor, step } = e.statement;
    if (reversed.has(vendor)) return false;
    if (step === 'reserve' && !confirmed.has(vendor)) return false;
    return true;
  });
  return standing.length ? 'in-doubt' : 'unwound';
}

export async function verifyReceipt(receipt, resolve = originResolver()) {
  const findings = [];
  const complaints = [];
  // Things a reader must know that are not, by themselves, evidence of
  // dishonesty. A commitment that unwound genuinely has no confirm statement,
  // and failing it for that would make every honest failure look like a forgery.
  const notes = [];
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

  // ── nothing was left out ────────────────────────────────────────────────
  // Each vendor signed the shape of the whole commitment, so a receipt is
  // checked against what its own participants said it was going to be. Signing
  // only the party list was not enough: dropping one of a vendor's two
  // statements left every party still represented, and the receipt -- rebuilt
  // around what remained -- verified cleanly while hiding that money moved.
  const plans = entries.map((e) => canonical(e.statement?.plan ?? null));
  if (new Set(plans).size > 1) {
    complaints.push('the statements disagree about what this commitment was going to be');
  }

  // Two statements under one idempotency key are two accounts of the same
  // step. A signer cannot reliably prevent this -- dedup memory in a
  // serverless function is per-instance, so two invocations can each sign once
  // and believe they were the first. It is caught here instead, where the whole
  // receipt is in view.
  const byKey = new Map();
  for (const e of entries) {
    const key = e.statement?.idempotencyKey;
    if (!key) continue;
    const body = canonical(e.statement);
    if (byKey.has(key) && byKey.get(key) !== body) {
      complaints.push(`two different statements are signed under the same idempotency key `
        + `"${key}" — one step cannot have happened two ways`);
      break;
    }
    byKey.set(key, body);
  }

  const plan = entries[0]?.statement?.plan ?? null;
  if (!plan) {
    complaints.push('no statement attests to the shape of this commitment, so it cannot be '
      + 'shown to be complete');
  } else {
    // ── the outcome is derived, never believed ────────────────────────────
    //
    // receipt.outcome is written by the coordinator and signed by nobody:
    // statement() covers sagaId, origin, vendor, parties, plan, step,
    // idempotencyKey, at and result, and deliberately not this. It used to
    // decide how strictly the rest of this function checked, which meant a
    // coordinator that had charged you could drop the charge, write "unwound"
    // -- or "Committed", or "commited", or nothing at all -- and the receipt
    // verified clean with ok:true and no complaints. Seven variations of that
    // attack are in attacks/run.mjs.
    //
    // So every rule below runs against what the statements themselves say
    // happened. The declared outcome is one more claim to check, not an input
    // that relaxes the checking.
    const derived = deriveOutcome(plan, entries);
    if (!OUTCOMES.has(receipt.outcome)) {
      complaints.push(`"${receipt.outcome}" is not an outcome; a receipt must claim one of `
        + `${[...OUTCOMES].join(', ')}`);
    } else if (receipt.outcome !== derived) {
      complaints.push(`this receipt claims "${receipt.outcome}", but its own statements `
        + `describe "${derived}"`);
    }

    // ── every party accounts for itself ───────────────────────────────────
    //
    // Silence used to be read as absence of effect, which is the one reading
    // it cannot bear: a party that did nothing and a party whose statement was
    // deleted look identical. So a participant that was named in the plan and
    // performed nothing signs that too (§15), and a missing party is a
    // complaint every time rather than a note when the outcome happens to
    // suit.
    const present = new Set(entries.map((e) => e.statement.vendor));
    const missing = (plan.parties ?? []).filter((v) => !present.has(v));
    if (missing.length) {
      complaints.push(`no statement of any kind from ${missing.join(', ')}, who every other `
        + 'vendor names as party to this. A participant that did nothing signs that it did '
        + 'nothing, so silence here is a gap in the receipt rather than evidence about the world');
    }

    const seen = new Set(entries.map((e) => `${e.statement.vendor}.${e.statement.step}`));
    const unaccounted = (plan.steps ?? []).filter((step) => !seen.has(step));

    if (derived === OUTCOME_COMMITTED && unaccounted.length) {
      complaints.push(`this accounts for every party but not for ${unaccounted.join(', ')}`);
    } else if (unaccounted.length) {
      // Named, not waved through: which steps did not happen is the substance
      // of a partial outcome, and the reader has to be told them.
      notes.push(`${unaccounted.join(', ')} never happened, which is what "${derived}" means`);
    }

    const stray = entries.filter((e) =>
      !(plan.steps ?? []).includes(`${e.statement.vendor}.${e.statement.step}`)
      && !REVERSALS.has(e.statement.step) && e.statement.step !== NOTHING);
    if (stray.length) {
      complaints.push(`${stray.map((e) => `${e.statement.vendor}.${e.statement.step}`).join(', ')} `
        + 'is not a step this commitment was planned to contain');
    }
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

    // Fails closed. verifyStatement accepts a bare JWK as well as a full key
    // record, so a resolver that returned one skipped the window check
    // entirely: `jwk?.publicKey` was undefined, inForce stayed true, and a key
    // retired last March could sign something dated this June. The shipped
    // resolver returns full records, so this was never live -- which is
    // precisely the kind of defect that survives, because nothing exercises
    // the default nobody uses.
    const record = normaliseKeyRecord(jwk);
    let signed = false;
    let inForce = true;
    if (record && !why) {
      if (!record.publicKey) {
        why = `${origin} published no usable key material for ${entry.keyId}`;
      } else {
        signed = await verifyStatement(entry, record);
        // A key that verifies but was not entitled to sign at that moment is
        // worse than no signature, because it looks like one.
        if (signed) {
          const window = keyValidAt({ ...record, vendor }, entry.statement?.at);
          if (!window.ok) { inForce = false; signed = false; why = window.why; }
        }
      }
    }

    findings.push({
      index: i, vendor, origin, step: entry.statement?.step, keyId: entry.keyId,
      included, signed, inForce, ok: included && signed, ...(why && { why }),
    });
  }

  return {
    ok: complaints.length === 0 && findings.every((f) => f.ok),
    root, findings, complaints, notes,
  };
}

/**
 * What a single vendor checks, holding only its own entry, its proof, and the
 * root. It learns nothing about the others -- the proof is opaque hashes.
 */
export async function verifyOwnEntry({ entry, proof, root, jwk, at }) {
  const included = await verifyInclusion(await leafHash(entry), proof, root);
  const record = normaliseKeyRecord(jwk);
  if (!record?.publicKey) return { ok: false, included, signed: false, inForce: false,
    why: 'no usable key material' };

  const signed = await verifyStatement(entry, record);
  // The same window check the full verifier does. A vendor checking its own
  // entry against a key it has since retired should get the same answer as
  // everybody else, and used to get a cheerier one.
  const window = signed
    ? keyValidAt({ ...record, vendor: entry.statement?.vendor }, at ?? entry.statement?.at)
    : { ok: true };
  return {
    ok: included && signed && window.ok,
    included, signed: signed && window.ok, inForce: window.ok,
    ...(window.ok ? {} : { why: window.why }),
  };
}
