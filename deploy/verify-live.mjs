#!/usr/bin/env node
// Check a deployment is actually usable, rather than merely returning 200.
//
// Everything here has failed silently at least once: a page that is somebody
// else's project, headers the WebMCP cross-origin path needs and does not get,
// and a signing key that regenerates per request so receipts verify now and
// never again.

import { LIVE } from '../origins.mjs';
import { VENDORS } from '../config.mjs';

let bad = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) bad++;
};

const app = await fetch(LIVE.app).then((r) => r.text()).catch(() => '');
check(/<title>Concord<\/title>/.test(app), 'the coordinator is Concord and not another project');
check(/id="frames"/.test(app), 'the coordinator page is the agent surface');

for (const id of VENDORS) {
  const origin = LIVE[id];
  console.log(`\n  ${id} — ${origin}`);
  const head = await fetch(origin).catch(() => null);
  check(head?.ok === true, 'reachable');
  check(head?.headers.get('origin-agent-cluster') === '?1', 'Origin-Agent-Cluster: ?1');
  const pp = head?.headers.get('permissions-policy') ?? '';
  check(pp.includes(LIVE.app), 'Permissions-Policy names the coordinator', pp || '(absent)');

  // Two reads. A key that changes between them is generated per invocation,
  // which means no receipt it signs will ever verify afterwards.
  const [a, b] = await Promise.all([
    fetch(`${origin}/.well-known/concord.json`).then((r) => r.json()).catch(() => null),
    fetch(`${origin}/.well-known/concord.json?x=2`).then((r) => r.json()).catch(() => null),
  ]);
  check(a?.vendor === id, 'publishes a key document naming itself', a?.vendor ?? '(none)');
  check(Boolean(a?.keys?.[0]?.keyId) && a.keys[0].keyId === b?.keys?.[0]?.keyId,
    'the signing key is stable across requests', a?.keys?.[0]?.keyId ?? '');
}

console.log(`\n${bad ? `${bad} problem(s)` : 'the deployment is usable'}`);
process.exit(bad ? 1 : 0);
