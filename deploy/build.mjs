#!/usr/bin/env node
// Assemble one self-contained bundle per origin.
//
// Concord needs its participants to be genuinely different origins -- that is
// the whole premise -- so each becomes its own deployment rather than a path on
// one host. Every bundle carries the shared modules it needs, the headers the
// WebMCP cross-origin path requires, and two functions: the key it publishes
// and the signature it produces.

import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDORS, TITLES } from '../config.mjs';
import { LIVE } from '../origins.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.deploy');

const SHARED = ['config.mjs', 'origins.mjs', 'shim/webmcp.mjs', 'shim/adapter.mjs',
                'kit/canonical.mjs'];

async function copy(bundle, files) {
  for (const f of files) {
    await mkdir(join(bundle, dirname(f)), { recursive: true });
    await cp(join(root, f), join(bundle, f));
  }
}

/**
 * Headers the cross-origin tool path actually requires.
 *
 * The allowlist differs by side, and getting it the same on both is the bug
 * that only shows up on the real API. `allow="tools"` delegates a feature the
 * *embedder* already has, so the coordinator's policy must name the origins it
 * embeds. Naming only itself, it had nothing to delegate: every vendor
 * registered its tools happily and the coordinator saw none of them, with no
 * error anywhere -- which is precisely how a polyfill that enforces none of
 * this hides the problem until you run it in a browser.
 */
const headersFor = (allow) => [{
  source: '/(.*)',
  headers: [
    // Cross-document tool access requires an origin-keyed agent cluster.
    // Without it getTools() comes back empty, also with no error.
    { key: 'Origin-Agent-Cluster', value: '?1' },
    { key: 'Permissions-Policy', value: `tools=(self ${allow.map((o) => `"${o}"`).join(' ')})` },
  ],
}];

async function buildVendor(id, appOrigin) {
  const bundle = join(out, `concord-${id}`);
  await rm(bundle, { recursive: true, force: true });
  await mkdir(bundle, { recursive: true });

  await copy(bundle, [...SHARED, 'kit/vendor.mjs', 'kit/vendor.css', 'kit/keystore.mjs']);
  await cp(join(root, 'vendors', id), bundle, { recursive: true });

  await mkdir(join(bundle, 'api'), { recursive: true });
  await writeFile(join(bundle, 'api', 'wellknown.js'), `
// What this vendor publishes about itself. Public, cacheable, no secrets.
import { wellKnown } from '../kit/keystore.mjs';
export default async function handler(req, res) {
  const origin = \`https://\${req.headers['x-forwarded-host'] ?? req.headers.host}\`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json(await wellKnown(${JSON.stringify(id)}, origin));
}
`.trimStart());

  await writeFile(join(bundle, 'api', 'sign.js'), `
// This vendor's application asking its own backend to sign what it just did.
//
// Bounded rather than open: it signs only for this vendor at this origin, and
// only once per idempotency key, so a compromised page cannot forge another
// party's word or go back and restate its own.
import { sign } from '../kit/keystore.mjs';
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  // Same-origin only. Not left to a CORS preflight failing by accident.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return res.status(403).json({ error: 'same-origin only' });
  const origin = \`https://\${req.headers['x-forwarded-host'] ?? req.headers.host}\`;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    res.status(200).json(await sign(${JSON.stringify(id)}, body?.statement, origin));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
`.trimStart());

  await writeFile(join(bundle, 'vercel.json'), JSON.stringify({
    rewrites: [
      { source: '/.well-known/concord.json', destination: '/api/wellknown' },
      { source: '/_concord/sign', destination: '/api/sign' },
    ],
    // A participant delegates back to the coordinator that embeds it.
    headers: headersFor([appOrigin]),
  }, null, 2));

  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: `concord-${id}`, private: true, type: 'module',
  }, null, 2));

  return bundle;
}

async function buildApp(appOrigin) {
  const bundle = join(out, 'concord-app');
  await rm(bundle, { recursive: true, force: true });
  await mkdir(bundle, { recursive: true });

  // The suite harness lives with the other shared machinery now.
  await copy(bundle, [...SHARED, 'kit/harness.mjs']);
  await mkdir(join(bundle, 'concord'), { recursive: true });
  for (const f of ['ladder.mjs', 'saga.mjs', 'journal.mjs', 'recover.mjs', 'receipt.mjs',
                   'client.mjs', 'agent-surface.mjs']) {
    await cp(join(root, 'concord', f), join(bundle, 'concord', f));
  }
  for (const [from, to] of [
    ['app/concord.html', 'index.html'],
    ['app/concord.mjs', 'concord.mjs'],
    ['app/agent.mjs', 'agent.mjs'],
    ['app/agent-tools.mjs', 'agent-tools.mjs'],
    // The conformance suite ships with the deployment, so anyone can point it
    // at these participants -- or their own -- without cloning anything.
    // The integration suite ships too: "the protocol against real origins" is
    // worth more when the origins are the deployed ones and anyone can run it.
    ['app/concord-test.html', 'concord-test.html'],
    ['app/concord-test.mjs', 'concord-test.mjs'],
    ['app/native.html', 'native.html'],
    ['app/native.mjs', 'native.mjs'],
    ['app/conformance.html', 'conformance.html'],
    ['app/conformance.mjs', 'conformance.mjs'],
    ['spec/conformance.mjs', 'spec/conformance.mjs'],
    // Self-hosted. A page whose argument is about who you trust should not open
    // with a request to a third party's font server.
    ['app/fonts/serif-400.woff2', 'fonts/serif-400.woff2'],
    ['app/fonts/serif-600.woff2', 'fonts/serif-600.woff2'],
    ['app/fonts/mono-400.woff2', 'fonts/mono-400.woff2'],
    ['app/fonts/mono-600.woff2', 'fonts/mono-600.woff2'],
  ]) {
    await mkdir(join(bundle, dirname(to)), { recursive: true });
    await cp(join(root, from), join(bundle, to));
  }

  // The page loads ./concord.mjs at the root of its own deployment.
  const html = (await readFile(join(bundle, 'index.html'), 'utf8'))
    .replace('./concord.mjs', '/concord.mjs');
  await writeFile(join(bundle, 'index.html'), html);

  // The coordinator delegates to every origin it embeds. This is the half that
  // was missing, and it is the half that matters.
  await writeFile(join(bundle, 'vercel.json'), JSON.stringify({
    headers: headersFor(VENDORS.map((id) => LIVE[id]).filter(Boolean)),
  }, null, 2));
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'concord-app', private: true, type: 'module',
  }, null, 2));

  return bundle;
}

const appOrigin = process.env.APP_ORIGIN ?? LIVE?.app;
if (!appOrigin) {
  console.error('No app origin. Set LIVE in origins.mjs, or APP_ORIGIN, before building:');
  console.error('a vendor deployed against the wrong coordinator exposes its tools to nobody.');
  process.exit(2);
}
await rm(out, { recursive: true, force: true });
const built = [await buildApp(appOrigin)];
for (const id of VENDORS) built.push(await buildVendor(id, appOrigin));

console.log(`built ${built.length} bundles in .deploy/`);
for (const b of built) console.log(`  ${b.replace(root + '/', '')}`);
console.log(`\nvendors will accept tool calls from ${appOrigin}`);
