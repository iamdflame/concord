// Two-origin dev server. No dependencies.
//
// Origin A  http://localhost:5173  -> app/       (the Concord coordinator)
// Origins    http://localhost:5177+ -> vendors/   (the participants)
//
// Different ports are different origins, and localhost is a "potentially
// trustworthy" origin, so both are secure contexts without TLS. That is what
// lets us exercise the real cross-origin path with no certificate work.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { wellKnown, sign } from './kit/keystore.mjs';
import { LOCAL_PORTS, VENDORS } from './config.mjs';

// Three supervised processes, each a separate origin. One page wearing three
// hats would prove nothing: the point is that composition crosses real trust
// boundaries the browser enforces.
// Ports come from the one origin table, so local and deployed cannot drift.
const ROOTS = { app: 'app', verify: 'verifier' };
const CONCORD = Object.fromEntries(Object.entries(LOCAL_PORTS).map(([port, id]) =>
  [port, { root: ROOTS[id] ?? `vendors/${id}`, name: id }]));

const ORIGINS = {
  ...CONCORD,
  // Ring 0's three supervised processes, the substrate Concord was built on.
  5174: { root: 'ring0/mail',   name: 'mail'   },
  5175: { root: 'ring0/ledger', name: 'ledger' },
  5176: { root: 'ring0/pay',    name: 'pay'    },
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.woff2':'font/woff2',
};

// The spec requires an origin-keyed agent cluster for cross-document tool
// access. Without this header the browser may bucket same-site documents into
// one agent cluster and getTools() will come back empty with no error, which
// is a genuinely difficult failure to diagnose.
// Every origin delegates to every other locally. Deployed, the split matters --
// the coordinator must name what it embeds -- and getting it wrong there is
// invisible under the polyfill, which enforces none of this.
const ALLOWED = Object.keys(ORIGINS).map((p) => `"http://localhost:${p}"`).join(' ');

/**
 * Three different policies, for three different jobs.
 *
 * The conformance suite must be able to embed an origin nobody listed, which is
 * the whole job. The verifier must not be able to use the feature at all: it is
 * the origin whose value is that it depends on nothing here, and `tools=()`
 * says so in a header rather than in a paragraph. Everywhere else the allowlist
 * is the control. deploy/build.mjs writes the same three.
 */
function policyFor(name, path) {
  if (name === 'verify') return 'tools=()';
  if (path === '/conformance.html') return 'tools=*';
  return `tools=(self ${ALLOWED})`;
}

function headers(type, path, name) {
  return {
    'Content-Type': type,
    'Origin-Agent-Cluster': '?1',
    'Permissions-Policy': policyFor(name, path),
    'Cache-Control': 'no-store',
  };
}

function serve(port) {
  const { root, name } = ORIGINS[port];
  const handler = async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let path = decodeURIComponent(url.pathname);
    const origin = `http://localhost:${port}`;

    // A vendor publishes its signing key on its own origin. Anyone verifying a
    // receipt fetches it from here over TLS, so the web's existing origin
    // guarantee is what binds the key to the party -- no registry to run, and
    // nothing for the coordinator to vouch for.
    // Only participants sign, so only participants publish. Deployed, this
    // function exists in the vendor bundles and nowhere else; locally it was
    // served on every origin, so the coordinator and the verifier published
    // signing keys they have no use for -- and the roll call on /judge.html,
    // which checks that neither does, failed against the dev server while
    // passing against production. A dev server that models the deployment
    // loosely is a dev server that hides exactly this.
    if (path === '/.well-known/concord.json' && !VENDORS.includes(name)) {
      res.writeHead(404, { ...headers(TYPES['.json'], path, name),
                           'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: `${name} signs nothing, so it publishes no key` }));
    }
    if (path === '/.well-known/concord.json') {
      const body = JSON.stringify(await wellKnown(name, origin), null, 2);
      res.writeHead(200, { ...headers(TYPES['.json'], path, name), 'Access-Control-Allow-Origin': '*',
                           'Cache-Control': 'public, max-age=300' });
      return res.end(body);
    }

    // The vendor's application asks its own backend to sign what it just did.
    // Same origin, so this is the page-to-backend hop a real vendor already has.
    if (path === '/_concord/sign' && req.method === 'POST') {
      // The deployed function enforces this; if local development does not, a
      // control is only ever exercised where nobody is looking at it.
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin') {
        res.writeHead(403, headers(TYPES['.json'], path, name));
        return res.end(JSON.stringify({ error: 'same-origin only' }));
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      // Do the work before writing headers. Committing to 200 and then failing
      // leaves nothing to report the failure with, and the second writeHead
      // takes the process down with it.
      try {
        const { statement } = JSON.parse(Buffer.concat(chunks).toString());
        const signed = await sign(name, statement, origin);
        res.writeHead(200, headers(TYPES['.json'], path, name));
        return res.end(JSON.stringify(signed));
      } catch (err) {
        res.writeHead(400, headers(TYPES['.json'], path, name));
        return res.end(JSON.stringify({ error: err.message }));
      }
    }
    if (path === '/' || path.endsWith('/')) path += 'index.html';

    // Shared modules live outside the per-origin roots; every origin needs them.
    // Shared modules and the origin table live outside the per-origin roots.
    const base = /^\/(shim|kit|concord|spec|ring0|ui|brand|attacks|verify)\//.test(path)
      || /^\/(config|origins)\.mjs$/.test(path) ? '.'
      // Ring 0's own shared stylesheet, kept with Ring 0.
      : path.startsWith('/shared/') ? 'ring0' : root;
    const file = join(process.cwd(), base, normalize(path).replace(/^(\.\.[/\\])+/, ''));

    try {
      const body = await readFile(file);
      res.writeHead(200, headers(TYPES[extname(file)] ?? 'application/octet-stream', path, name));
      res.end(body);
    } catch {
      res.writeHead(404, headers('text/plain; charset=utf-8', path, name));
      res.end(`404 ${path}`);
    }
  };

  createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, headers(TYPES['.json']));
      res.end(JSON.stringify({ error: err.message }));
    });
  }).listen(port, () => {
    console.log(`  ${name.padEnd(9)} http://localhost:${port}`);
  });
}

console.log('Ring 0 dev origins:');
for (const port of Object.keys(ORIGINS)) serve(Number(port));
console.log('\nOpen the kernel origin to run the Phase 01 assertions.');
