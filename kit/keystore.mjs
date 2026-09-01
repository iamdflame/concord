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

/**
 * Where a signing key comes from, in order of preference.
 *
 * A deployed vendor reads its key from the environment. Writing keypairs to
 * disk is fine on a laptop and fatal on a serverless host: the filesystem is
 * read-only or per-invocation, so the key regenerates, /.well-known publishes
 * one that did not sign the statement, and every receipt fails to verify. The
 * best feature in the project breaks first, and quietly.
 *
 * CONCORD_KEY_FLY, CONCORD_KEY_STAY, … or CONCORD_SIGNING_JWK for a single
 * deployment. The value is a JWK with its private half.
 */
function fromEnv(vendor) {
  const raw = process.env[`CONCORD_KEY_${vendor.toUpperCase()}`] ?? process.env.CONCORD_SIGNING_JWK;
  if (!raw) return null;
  let privateKey;
  try { privateKey = JSON.parse(raw); }
  catch { throw new Error(`CONCORD_KEY_${vendor.toUpperCase()} is not valid JSON`); }
  if (privateKey.kty !== 'EC' || !privateKey.d) {
    throw new Error(`CONCORD_KEY_${vendor.toUpperCase()} is not an EC private JWK`);
  }
  // The public half is the same key without the private scalar.
  const { d, key_ops, ...publicKey } = privateKey;
  return { vendor, privateKey, publicKey: { ...publicKey, key_ops: ['verify'] },
           createdAt: privateKey.concordCreatedAt ?? '2026-01-01T00:00:00.000Z', source: 'environment' };
}

async function load(vendor) {
  try { return { ...JSON.parse(await readFile(join(DIR, `${vendor}.json`), 'utf8')), source: 'disk' }; }
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
    source: 'generated',
  };
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(join(DIR, `${vendor}.json`), JSON.stringify(record, null, 2));
  } catch {
    // Read-only filesystem. Carrying on with a key that dies with this process
    // would publish one thing and sign with another, so say so.
    console.warn(`[concord] ${vendor} could not persist a signing key and none was supplied. `
      + `Set CONCORD_KEY_${vendor.toUpperCase()} or receipts will not verify across restarts.`);
  }
  return record;
}

const cache = new Map();

export async function keyFor(vendor) {
  if (!cache.has(vendor)) {
    cache.set(vendor, fromEnv(vendor) ?? (await load(vendor)) ?? (await create(vendor)));
  }
  const record = await cache.get(vendor);
  if (!record.keyId) record.keyId = (await sha256(canonical(record.publicKey))).slice(0, 16);
  return record;
}

/**
 * What the vendor publishes about itself. Public, cacheable, no secrets.
 *
 * Keys carry a validity window and a status, because "this receipt still
 * verifies in a year" is only true if a key compromised in month six can be
 * said to be compromised. Without that, the holder of a stolen key can forge
 * the entire history retroactively and no verifier has any way to object.
 *
 * Two kinds of withdrawal, and they mean different things to old receipts:
 *
 *   rotated      the key was retired in the ordinary way. Statements signed
 *                while it was live stay valid; later ones do not.
 *   compromised  it was in someone else's hands from `since` onward, so
 *                nothing signed after that moment can be trusted, however
 *                well the signature verifies.
 *
 * A revocation file at .keys/<vendor>.revoked.json drives this, so a vendor can
 * declare one without redeploying.
 */
export async function wellKnown(vendor, origin) {
  const { keyId, publicKey, createdAt } = await keyFor(vendor);
  let withdrawal = null;
  try { withdrawal = JSON.parse(await readFile(join(DIR, `${vendor}.revoked.json`), 'utf8')); }
  catch { /* nothing withdrawn */ }

  const key = {
    keyId, alg: 'ES256', publicKey,
    notBefore: createdAt,
    status: withdrawal?.status ?? 'active',
    ...(withdrawal?.status === 'rotated' && { retiredAt: withdrawal.at }),
    ...(withdrawal?.status === 'compromised' && { compromisedSince: withdrawal.since ?? withdrawal.at }),
    ...(withdrawal?.reason && { reason: withdrawal.reason }),
  };
  return { concord: 1, vendor, origin, keys: [key] };
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
