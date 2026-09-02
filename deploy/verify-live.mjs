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

  // Publishing and signing are different invocations of different functions.
  // If they disagree, every receipt this participant signs fails to verify --
  // quietly, and only for whoever tries to check one later.
  const signed = await fetch(`${origin}/_concord/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ statement: {
      vendor: id, origin, idempotencyKey: `deploy-check-${crypto.randomUUID()}`, result: {} } }),
  }).then((r) => r.json()).catch(() => null);
  check(Boolean(signed?.keyId) && signed.keyId === a?.keys?.[0]?.keyId,
    'it signs with the key it publishes', signed?.keyId ?? signed?.error ?? '(no answer)');
}

// ── the verifier ───────────────────────────────────────────────────────────
// Its whole value is what it is not: not the coordinator, not a participant,
// and not able to use the feature the rest of this runs on. Each of those is
// checkable from outside, so each is checked -- a verifier that quietly gained
// a tools policy, or that started publishing a key as though it signed things,
// would still return 200 and would still look right.
{
  const origin = LIVE.verify;
  console.log(`\n  verify — ${origin}`);
  const res = await fetch(origin).catch(() => null);
  check(res?.ok === true, 'reachable');

  const page = await res?.text().catch(() => '') ?? '';
  check(/<title>Concord — receipts<\/title>/.test(page), 'it is the receipt verifier');

  const pp = res?.headers.get('permissions-policy') ?? '';
  check(pp.replace(/\s+/g, '') === 'tools=()',
    'it delegates tools to nobody, including itself', pp || '(absent)');
  check(!pp.includes(LIVE.app), 'and names no coordinator');

  // It signs nothing, so it has nothing to publish. A key document here would
  // mean this origin had become a party rather than a checker of them.
  const keys = await fetch(`${origin}/.well-known/concord.json`).catch(() => null);
  check(keys?.ok !== true, 'it publishes no signing key, because it signs nothing');

  // The verifier reads key documents cross-origin. Without CORS on the
  // participants' side it would fail for every receipt, in the browser only.
  for (const id of VENDORS) {
    const acao = await fetch(`${LIVE[id]}/.well-known/concord.json`)
      .then((r) => r.headers.get('access-control-allow-origin')).catch(() => null);
    check(acao === '*', `${id} lets another origin read its key document`, acao ?? '(absent)');
  }
}

console.log(`\n${bad ? `${bad} problem(s)` : 'the deployment is usable'}`);
process.exit(bad ? 1 : 0);
