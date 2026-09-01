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

/** Exactly what a vendor puts its name to. Nothing here is the coordinator's. */
export function statement({ sagaId, vendor, step, idempotencyKey, result }) {
  return { sagaId, vendor, step, idempotencyKey, result };
}

export async function importVerifyKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

export async function verifyStatement(entry, jwk) {
  if (!entry.signature || !jwk) return false;
  const key = await importVerifyKey(jwk);
  const bytes = new TextEncoder().encode(canonical(entry.statement));
  const sig = Uint8Array.from(atob(entry.signature), (c) => c.charCodeAt(0));
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, bytes);
}

// ── the receipt ─────────────────────────────────────────────────────────────

export async function buildReceipt({ sagaId, outcome, entries, keys }) {
  const leaves = await Promise.all(entries.map(leafHash));
  const { root, levels } = await buildTree(leaves);
  return {
    version: 1,
    sagaId,
    outcome,
    root,
    at: new Date().toISOString(),
    entries,
    keys,                                  // vendor id -> public JWK, as declared
    proofs: entries.map((_, i) => proofFor(levels, i)),
  };
}

/**
 * Verify the whole receipt: every statement signed by the vendor that made it,
 * and every entry provably part of this root.
 */
export async function verifyReceipt(receipt) {
  const findings = [];
  const leaves = await Promise.all(receipt.entries.map(leafHash));
  const { root } = await buildTree(leaves);

  if (root !== receipt.root) {
    findings.push({ ok: false, why: 'the entries do not hash to the stated root' });
    return { ok: false, findings };
  }

  for (const [i, entry] of receipt.entries.entries()) {
    const included = await verifyInclusion(leaves[i], receipt.proofs[i], receipt.root);
    const signed = await verifyStatement(entry, receipt.keys?.[entry.statement.vendor]);
    findings.push({
      index: i,
      vendor: entry.statement.vendor,
      step: entry.statement.step,
      included,
      signed,
      ok: included && signed,
    });
  }
  return { ok: findings.every((f) => f.ok), root, findings };
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
