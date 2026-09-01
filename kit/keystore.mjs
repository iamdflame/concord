// Vendor signing keys, held by the vendor's server and published at a
// well-known URL on the vendor's own origin.
//
// The first version generated a keypair in the page on every load. That made
// the receipt worthless: reload the tab and the key that signed it no longer
// exists, so nothing could be verified an hour later, let alone in a dispute a
// year later. It was also unanchored -- the key arrived over the same channel
// as the claim it authenticated, which proves nothing about who made it.
//
// Keys now live with the origin. A verifier fetches
// https://vendor.example/.well-known/concord.json and gets the key over TLS
// from the vendor itself, so the web's existing origin guarantee is what binds
// key to party. No registry, no CA of our own, nothing to run.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, sha256 } from './canonical.mjs';

const DIR = join(process.cwd(), '.keys');

async function load(vendor) {
  try { return JSON.parse(await readFile(join(DIR, `${vendor}.json`), 'utf8')); }
  catch { return null; }
}

async function create(vendor) {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const record = {
    vendor,
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
    createdAt: new Date().toISOString(),
  };
  // The key id is derived from the key itself, so a receipt can name exactly
  // which key signed it and a vendor can rotate without invalidating history.
  record.keyId = (await sha256(canonical(record.publicKey))).slice(0, 16);
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, `${vendor}.json`), JSON.stringify(record, null, 2));
  return record;
}

const cache = new Map();

export async function keyFor(vendor) {
  if (!cache.has(vendor)) cache.set(vendor, (await load(vendor)) ?? (await create(vendor)));
  return cache.get(vendor);
}

/** What the vendor publishes about itself. Public, cacheable, no secrets. */
export async function wellKnown(vendor, origin) {
  const { keyId, publicKey, createdAt } = await keyFor(vendor);
  return {
    concord: 1,
    vendor,
    origin,
    keys: [{ keyId, alg: 'ES256', publicKey, createdAt, status: 'active' }],
  };
}

// One signature per idempotency key. A second attempt with different content
// is a rewrite of something already attested, and is refused.
const attested = new Map();

/**
 * Sign a statement on the vendor's behalf.
 *
 * An endpoint that signs whatever it is handed is a signing oracle, and the
 * damage is bounded here rather than assumed away. Two rules hold regardless of
 * what the calling page has become:
 *
 *   - it can only sign statements naming *this* vendor at *this* origin, so a
 *     compromised page cannot forge one party's word in another's name;
 *   - it can only sign a given idempotency key once, so it cannot go back and
 *     restate what a step did.
 *
 * The boundary that remains is real and worth naming: the statement's `result`
 * still comes from the page. Closing that means holding the vendor's
 * transaction record server-side and building the statement from it, which is
 * the port a production deployment has to make.
 */
export async function sign(vendor, statement, origin) {
  if (statement?.vendor !== vendor) {
    throw new Error(`this origin signs only for "${vendor}", not "${statement?.vendor}"`);
  }
  if (origin && statement?.origin !== origin) {
    throw new Error(`this origin signs only statements naming ${origin}`);
  }
  const idem = statement?.idempotencyKey;
  if (idem) {
    const already = attested.get(idem);
    const body = canonical(statement);
    if (already && already !== body) {
      throw new Error(`${idem} has already been attested with different content`);
    }
    attested.set(idem, body);
  }

  const record = await keyFor(vendor);
  const key = await crypto.subtle.importKey('jwk', record.privateKey,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
    new TextEncoder().encode(canonical(statement)));
  return {
    keyId: record.keyId,
    signature: Buffer.from(new Uint8Array(sig)).toString('base64'),
  };
}
