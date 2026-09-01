#!/usr/bin/env node
// Generate signing keys for a deployment, as environment variables.
//
// A deployed vendor must not generate its own key: serverless filesystems are
// read-only or per-invocation, so it would publish one key and sign with
// another and every receipt would fail. These go into the host's secrets.
//
//   node tools/make-keys.mjs            # all vendors
//   node tools/make-keys.mjs fly stay   # some

import { VENDORS } from '../config.mjs';

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : VENDORS;

for (const vendor of wanted) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  jwk.concordCreatedAt = new Date().toISOString();
  console.log(`CONCORD_KEY_${vendor.toUpperCase()}=${JSON.stringify(jwk)}`);
}

console.error(`\n${wanted.length} keys. Set each as a secret on that vendor's deployment.`);
console.error('They are private: do not commit them, and do not paste them anywhere public.');
