// Two-origin dev server. No dependencies.
//
// Origin A  http://localhost:5173  -> kernel/    (Ring 0)
// Origin B  http://localhost:5174  -> workload/  (a process the kernel supervises)
//
// Different ports are different origins, and localhost is a "potentially
// trustworthy" origin, so both are secure contexts without TLS. That is what
// lets us exercise the real cross-origin path with no certificate work.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ORIGINS = {
  5173: { root: 'kernel',   name: 'kernel'   },
  5174: { root: 'workload', name: 'workload' },
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
};

// The spec requires an origin-keyed agent cluster for cross-document tool
// access. Without this header the browser may bucket same-site documents into
// one agent cluster and getTools() will come back empty with no error, which
// is a genuinely difficult failure to diagnose.
const ALLOWED = '"http://localhost:5173" "http://localhost:5174"';

function headers(type) {
  return {
    'Content-Type': type,
    'Origin-Agent-Cluster': '?1',
    'Permissions-Policy': `tools=(self ${ALLOWED})`,
    'Cache-Control': 'no-store',
  };
}

function serve(port) {
  const { root, name } = ORIGINS[port];
  createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let path = decodeURIComponent(url.pathname);
    if (path === '/' || path.endsWith('/')) path += 'index.html';

    // Shared modules live outside the per-origin root; both origins need them.
    const base = path.startsWith('/shim/') ? '.' : root;
    const file = join(process.cwd(), base, normalize(path).replace(/^(\.\.[/\\])+/, ''));

    try {
      const body = await readFile(file);
      res.writeHead(200, headers(TYPES[extname(file)] ?? 'application/octet-stream'));
      res.end(body);
    } catch {
      res.writeHead(404, headers('text/plain; charset=utf-8'));
      res.end(`404 ${path}`);
    }
  }).listen(port, () => {
    console.log(`  ${name.padEnd(9)} http://localhost:${port}`);
  });
}

console.log('Ring 0 dev origins:');
for (const port of Object.keys(ORIGINS)) serve(Number(port));
console.log('\nOpen the kernel origin to run the Phase 01 assertions.');
