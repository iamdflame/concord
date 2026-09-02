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

// The shared look. Two bundles serve pages, and a palette copied into each is
// two palettes that agree until someone edits one.
const UI = ['ui/instrument.css', 'ui/fonts/serif-400.woff2', 'ui/fonts/serif-600.woff2',
            'ui/fonts/mono-400.woff2', 'ui/fonts/mono-600.woff2'];

/**
 * Rebuild a bundle without losing which project it deploys to.
 *
 * `.vercel/project.json` is written into the bundle by `vercel link`, and a
 * plain rm -rf of the bundle takes it with everything else. The next
 * `vercel deploy` then has nothing to go on and quietly creates a new project
 * named after the directory -- so the build succeeds, the deploy succeeds, the
 * URL is wrong, and the origin everyone has the link to still serves the
 * previous version. That has now happened twice, both times invisibly.
 */
async function freshen(bundle) {
  let link = null;
  try { link = await readFile(join(bundle, '.vercel', 'project.json'), 'utf8'); } catch { /* unlinked */ }
  await rm(bundle, { recursive: true, force: true });
  await mkdir(bundle, { recursive: true });
  if (link) {
    await mkdir(join(bundle, '.vercel'), { recursive: true });
    await writeFile(join(bundle, '.vercel', 'project.json'), link);
  }
}

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

/**
 * The conformance suite is the one page that must be able to embed an origin
 * nobody has heard of.
 *
 * A suite that can only test the origins its own author listed is not a
 * conformance suite, it is a regression test with ambitions -- and the page has
 * been claiming, in its own copy, that you can point it at your own origin
 * since before there was any way to. `allow="tools"` can only delegate what
 * this document's own Permissions-Policy already grants it, so an allowlist of
 * six names means an arbitrary origin gets nothing, silently.
 *
 * `tools=*` on this one path is the cost. It is worth being precise about what
 * it does and does not buy an attacker: it lets any page *this document
 * embeds* register tools. This document embeds exactly what a human typed into
 * a box on it, and it holds nothing worth taking -- no keys, no journal, no
 * commitments, and no coordinator surface. The header stays off every other
 * path, including the coordinator's, where the allowlist is the control.
 *
 * Vercel applies every matching rule and the last one wins for a repeated key,
 * so this must come after the general rule above. deploy/verify-live.mjs
 * asserts both paths, because a header that regresses here fails the way all
 * of these fail: invisibly, and only in a real browser.
 */
const CONFORMANCE_HEADERS = {
  source: '/conformance.html',
  headers: [
    { key: 'Origin-Agent-Cluster', value: '?1' },
    { key: 'Permissions-Policy', value: 'tools=*' },
  ],
};

async function buildVendor(id, appOrigin) {
  const bundle = join(out, `concord-${id}`);
  await freshen(bundle);

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
  await freshen(bundle);

  // The suite harness lives with the other shared machinery now.
  // Fonts are self-hosted: a page whose argument is about who you trust should
  // not open with a request to a third party's font server.
  await copy(bundle, [...SHARED, 'kit/harness.mjs', ...UI]);
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
    headers: [...headersFor(VENDORS.map((id) => LIVE[id]).filter(Boolean)), CONFORMANCE_HEADERS],
  }, null, 2));
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'concord-app', private: true, type: 'module',
  }, null, 2));

  return bundle;
}

/**
 * The verifier, on an origin of its own.
 *
 * It ships the receipt code and nothing else: no coordinator, no participants,
 * no harness, no shim. It cannot register a tool, cannot embed anything, and
 * has no backend -- the receipt reaches it in a URL fragment or off the local
 * disk, and the only requests it makes are for the participants' public key
 * documents, from the origins named inside the signed statements.
 *
 * `tools=()` rather than an allowlist. An origin whose entire value is that it
 * depends on nothing here should say that in a header, where a browser enforces
 * it, and not only in a paragraph on the page.
 */
async function buildVerifier() {
  const bundle = join(out, 'concord-verify');
  await freshen(bundle);

  await copy(bundle, ['config.mjs', 'origins.mjs', 'kit/canonical.mjs', ...UI]);
  await mkdir(join(bundle, 'concord'), { recursive: true });
  await cp(join(root, 'concord', 'receipt.mjs'), join(bundle, 'concord', 'receipt.mjs'));
  await cp(join(root, 'verifier', 'index.html'), join(bundle, 'index.html'));
  await cp(join(root, 'verifier', 'verify.mjs'), join(bundle, 'verify.mjs'));

  const html = (await readFile(join(bundle, 'index.html'), 'utf8'))
    .replace('./verify.mjs', '/verify.mjs');
  await writeFile(join(bundle, 'index.html'), html);

  await writeFile(join(bundle, 'vercel.json'), JSON.stringify({
    headers: [{
      source: '/(.*)',
      headers: [
        { key: 'Origin-Agent-Cluster', value: '?1' },
        { key: 'Permissions-Policy', value: 'tools=()' },
      ],
    }],
  }, null, 2));
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'concord-verify-site', private: true, type: 'module',
  }, null, 2));

  return bundle;
}

const appOrigin = process.env.APP_ORIGIN ?? LIVE?.app;
if (!appOrigin) {
  console.error('No app origin. Set LIVE in origins.mjs, or APP_ORIGIN, before building:');
  console.error('a vendor deployed against the wrong coordinator exposes its tools to nobody.');
  process.exit(2);
}
// Not rm -rf .deploy: each bundle is freshened in place so its project link survives.
const built = [await buildApp(appOrigin)];
for (const id of VENDORS) built.push(await buildVendor(id, appOrigin));
built.push(await buildVerifier());

console.log(`built ${built.length} bundles in .deploy/`);
for (const b of built) console.log(`  ${b.replace(root + '/', '')}`);
console.log(`\nvendors will accept tool calls from ${appOrigin}`);
