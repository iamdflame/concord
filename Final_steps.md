PART 1 — THE AUDIT
A. Critical: the receipt integrity model is broken
A1. receipt.outcome is attacker-controlled, unsigned, and gates verification strictness

verifyReceipt decides how strict to be based on receipt.outcome === 'committed'. That field is written by the coordinator and signed by nobody — statement() covers sagaId, origin, vendor, parties, plan, step, idempotencyKey, at, result. No outcome.

I built an honest 3-vendor receipt with real keys, then dropped Rowan House's charge statement:

receipt.outcome	Verifier verdict
"committed"	✗ ok:false, 2 complaints — correctly caught
"unwound"	✓ ok:true, 0 complaints
"in-doubt"	✓ ok:true, 0 complaints
"Committed"	✓ ok:true, 0 complaints
"committed "	✓ ok:true, 0 complaints
"commited"	✓ ok:true, 0 complaints
null	✓ ok:true, 0 complaints

A coordinator that charged you $412 at Rowan House drops that statement, writes "Committed" with a capital C, and the receipt verifies clean. The user is told nothing stands. THREAT-MODEL.md lists "A coordinator drops an inconvenient statement" under Attacks that are closed. It is closed for exactly one spelling of one outcome value.

Three compounding bugs: strictness gated on unsigned data; no enum validation; exact string equality.

The fix is not to validate the string. The outcome must be derived, not declared. The verifier already knows plan.steps and which statements exist — it can compute the outcome and compare. A declared outcome should be an assertion the verifier checks, never an input that relaxes it.

A2. Missing parties produce notes, not complaints

Even ignoring A1, dropping a whole party only downgrades to a note when outcome ≠ committed. ok stays true. Silence from a vendor is treated as evidence of absence. It isn't — it's absence of evidence.

You need provable silence: a vendor signs {sagaId, vendor, step, happened: false}. Then a missing statement is always a complaint, because an honest non-participation has a signature too.

A3. Revocation checks are skipped for bare-JWK resolvers
js
let signed = jwk ? await verifyStatement(entry, jwk) : false;
if (signed && jwk?.publicKey) { /* keyValidAt */ }

verifyStatement accepts record?.publicKey ?? record — a bare JWK verifies fine. But then jwk?.publicKey is undefined, inForce stays true, and rotation and compromise windows are never checked. verifyOwnEntry() has no window check at all. The shipped originResolver returns full records, so this isn't live-exploitable — but it's a fail-open default in the one place that must fail closed.

A4. buildTree is unsafe as exported API

I demonstrated: tree(['a','b','c']).root === tree([H('ab'),'c']).root. Identical roots, different leaf sets.

Not exploitable through buildReceipt, because leafHash prefixes leaf: and nodeHash prefixes node:. But the code comment says promotion is safe because it isn't duplication — that reasoning is wrong. Domain separation is what saves it. The comment documents a defence that isn't the operative one, which is how the next contributor removes the real one.

Also: proofs commit to neither tree size nor leaf index. That's weaker than Certificate Transparency, which you're implicitly claiming parity with.

A5. The signing oracle — admitted, and it undercuts the entire pitch

keystore.mjs says it plainly: "the statement's result still comes from the page." In the deployed topology all six vendors run as frames in one tab. So the "counterparty-signed" statements are signed over values the coordinator's own tab produced. The receipt proves a key at that origin signed these bytes — not that vendor's books say this happened.

Every other integrity property rests on this one, and it's the one that's stubbed.

A6. Idempotency memory is in the wrong places
attested Map (keystore.mjs) is process memory. On Vercel that's per-instance — the "one signature per key" rule doesn't hold in the deployed topology. Admitted.
kit/vendor.mjs keeps honoured keys in localStorage. Admitted: user-editable, so concord.status can be made to lie; a private window reports steps that happened didn't; clearing site data makes a retry charge twice.

Recovery correctness depends entirely on a store the attacker controls.

A7. Ephemeral key generation fails open

If CONCORD_KEY_* is unset, create() generates a keypair, tries to write it, and on a read-only FS only console.warns. It then serves /.well-known/concord.json with a key that didn't sign anything. Every receipt fails to verify, silently, and only in production.

B. WebMCP leverage gaps

B1. requestUserInteraction appears nowhere in the codebase. I grepped everything. This is the spec's own consent primitive, and the project is about consent. Your argument — that the click must be in-page and unreachable by tools — is right, and registration-as-permission is the stronger mechanism. But they're complementary, not alternatives. A judge scoring "WebMCP leverage" sees an unused primitive in your exact problem domain. Every top-5 competitor uses it.

B2. No declarative HTML tools. No toolname= attributes anywhere. The read-only vendor surface is the natural place.

B3. No outputSchema on any tool.

B4. Tool surface is small — 11–16 tools. Toolbraid has 38, Glippy 21, PixelMesh 77, Finite 105. Yours are better-designed, but "6 tools" reads thin next to "38 across 6 origins."

B5. The shim is a 220-line reimplementation. The cross-origin story — exposedTo, fromOrigins, toolchange — is mostly exercised against your own postMessage polyfill unless the flag is on. adapter.mjs reports the provider honestly, which is to your credit, but a judge on the no-flag path is watching your code talk to your code.

B6. Hardcoded shim timeouts — 250ms in getTools, 8000ms in executeTool. A slow frame is silently dropped from discovery.

C. Execution and credibility

C1. CI never runs. on: workflow_dispatch. The comment explains it's an Actions billing block. The effect on a judge is identical to having no CI: no badge, no automated proof, and the honest explanation reads like an excuse. For a project whose entire pitch is every claim traces to executable code, this is the worst possible gap.

C2. 102 tests. Verified — the README's claim is accurate, which is to your credit. But Jig has 1,422 across 108 files. Toolbraid 466, Glippy 438. You are last among the leaders on the metric you chose as your differentiator.

C3. ring0/ is a different project living in your repo. ~20 files, its own README, its own phases 01–04, its own monitor, mail/ledger/pay processes. And its README contradicts itself mid-document: "Wait — :5173 is Concord's coordinator now." A judge who opens the repo sees two systems and can't tell which is the submission.

C4. experiments/tool-synthesis/ — leftover scaffolding.

C5. 1,404 lines of prose across README (590), SPEC (433), THREAT-MODEL (214), SUBMISSION (167). Judges give you minutes.

C6. Naming leak. The adversarial vendor has id shady, title "Meridian Holdings", origin concord-meridian. The id gives away the trick in concord_list_vendors output.

C7. Committed PNGs — 14 demo cards and banners in-repo.

C8. I could not reach the live site. My sandbox blocks non-allowlisted egress, so deployment health is unverified. Given A7, this is the risk I'd most want closed.

D. Conceptual critiques a judge will make

D1. The domain is invented. Six vendors you wrote. Jig grades knitting patterns its author actually uses. Toolbraid discovers live tools across real origins. "Six origins" is architecturally real but commercially synthetic — you built the counterparties that agree with you.

D2. The headline overstates. "Structurally incapable of overpromising" is true of the tool surface, not the browser. Your own threat model concedes a clicking agent defeats consent. The concession is excellent; the headline doesn't carry it.

D3. Most of the sophistication is invisible. The ladder, saga, journal, and recovery are the best code in this hackathon. A judge sees a page that refuses a plan.

PART 2 — THE REBUILD

Your idea is top-tier. I ranked you #3 and I'd have ranked you #1 on creativity. The gap to first is entirely execution and credibility. Here's how to close it.

Phase 0 — Fix the breaks (non-negotiable, ~2 days)

A judge who runs my attack script sinks you. Fix these first.

0.1 Derive the outcome. Replace outcome-gated strictness with computation:

js
function deriveOutcome(plan, entries) {
  const seen = new Set(entries.map(e => `${e.statement.vendor}.${e.statement.step}`));
  const reversals = entries.filter(e => REVERSALS.has(e.statement.step));
  if (plan.steps.every(s => seen.has(s))) return 'committed';
  if (reversals.length && !unreversedForward(entries).length) return 'unwound';
  return 'in-doubt';
}
// in verifyReceipt:
const derived = deriveOutcome(plan, entries);
if (!OUTCOMES.has(receipt.outcome)) complaints.push(`"${receipt.outcome}" is not an outcome`);
else if (receipt.outcome !== derived)
  complaints.push(`this claims "${receipt.outcome}"; its own statements describe "${derived}"`);

Every completeness rule then runs against derived, never receipt.outcome.

0.2 Provable silence. Add a null-statement: a vendor signs {sagaId, vendor, happened:false, plan, at}. Then require every party in plan.parties to have some signed statement. Missing party = complaint, always, regardless of outcome. This is the real fix for A2 and it's a genuine protocol contribution — publish it as SPEC §18.

0.3 Normalise resolver output. Fail closed.

js
const record = normaliseKeyRecord(await resolve(vendor, origin, entry.keyId));
if (!record?.publicKey) { why = 'no usable key record'; signed = false; }
else {
  signed = await verifyStatement(entry, record);
  const w = keyValidAt({ ...record, vendor }, entry.statement?.at);
  if (!w.ok) { inForce = false; signed = false; why = w.why; }
}

Same treatment in verifyOwnEntry.

0.4 Size- and index-committed Merkle tree. Move to CT-style splitting at the largest power of two, and fold leaf count into the root: root = H('concord-v2:' + n + ':' + treeRoot). Put the index in the proof and check it. Then delete the comment that misattributes the safety property.

0.5 Kill the oracle for at least two vendors. Move the transaction record server-side (Cloudflare D1 or Vercel KV) and construct the statement there from the vendor's own books. Keep two vendors on the page path and label the difference in the UI: "Northwind Air signs from its own ledger. Sandbox signs from the page." That contrast is worth more than closing it everywhere silently — it shows you know exactly where the boundary is.

0.6 Server-side idempotency. Replace localStorage and the attested Map with D1/KV. This is what makes recovery real rather than demonstrated.

0.7 Refuse to boot without keys. If CONCORD_KEY_* is missing, serve a 503 with an explicit message. Never generate an ephemeral key and warn.

0.8 Ship the attack script. Put my four attacks in attacks/ as executable tests that must fail. Add a page — /attack.html — where a judge fires them at the live deployment and watches them get rejected. Airlock does this (?attack=1) and it's the single most persuasive thing in that repo.

Phase 1 — Make WebMCP leverage undeniable (~2 days)

1.1 Add requestUserInteraction as a second consent path, and write the comparison up as SPEC §19: "Two consent mechanisms, and why absence is stronger than interruption." You now use the spec primitive and demonstrate its limits. That's the strongest possible position.

1.2 Declarative HTML tools for concord.protocol and concord.status on every vendor — toolname= on a real form. Zero-JS participation is a powerful adoption story: a vendor joins Concord with HTML attributes.

1.3 outputSchema on all 16 tools. Agents can then validate what came back.

1.4 A real toolchange demonstration. A vendor that registers mid-session; the coordinator re-plans live; the surface diffs. Show the delta in the UI: 21 tools → 25, these four arrived, none of the other 21 left.

1.5 Extract @concord/surface to npm. The Reconciler — one AbortController per tool, serialised queue, in-flight guard, argument checking, output budget — is a genuinely reusable library that nobody else has built. Publishing it makes you infrastructure, not an app. Pair it with the concord-verify package you already ship.

1.6 File the spec proposal for real. Open an issue and a PR against webmachinelearning/webmcp for the reversibility annotation (reversibleHint / commitmentSurface). SPEC §17 proposes it; an actual upstream issue with a link in your README converts "we propose" into "we filed." Alex Nahas and Ilya Grigorik are judges. Sarah Drasner is Chrome.

Phase 2 — Out-test the field (~4 days, biggest score delta)

Target 1,200+ assertions. Concretely:

2.1 Property-based testing (fast-check) — highest yield per hour:

Ladder: for any random participant set, if guarantee !== REFUSED then no irreversible step precedes any reversible one; at most one irreversible; pointOfNoReturn is always last.
Canonical: canonical(JSON.parse(JSON.stringify(x))) === canonical(x) for all JSON values; key order permutation invariance.
Merkle: for any leaf set and index, verifyInclusion(proof) is true; for any mutation, false.
Saga: for any fault injection schedule, no vendor ends with an unreversed reversible effect unless reported in stands or failures.

2.2 Deterministic simulation testing. A harness that runs the saga against vendors that fail at every step index, drop every reply, expire every hold, and crash the coordinator at every journal write. Assert invariants after each. This is what Jig's 1,422 tests actually are, and it's how you pass it.

2.3 Receipt fuzzer. Generate valid receipts, apply structured mutations — reorder entries, swap signatures, change one byte of result, drop a statement, change outcome case, replay across sagas — assert ok === false for every mutation that changes meaning. Aim for 300+ generated cases per run.

2.4 Mutation testing (Stryker). Report the score. A project claiming verifiability that shows a 90% mutation score has proof its tests bite; nobody else in this hackathon will have one.

2.5 Formal model. Encode the ladder in TLA+ or Alloy and machine-check the safety property: no reachable state has an irreversible effect with an unreversed reversible one after it. Check in the model and the trace. Jig claims "16 formal correctness properties, machine audited" — match it and you neutralise their strongest differentiator.

2.6 Keep the 32-state sweep but make it exhaustive over the real state tuple and assert FORBIDDEN against actual registered names, not stripped prefixes.

Phase 3 — Credibility (~1 day)

3.1 Get a green badge. Move CI to a fresh GitHub account, or GitLab CI, or Cirrus — all free for public repos. A red or absent badge on a verifiability project costs more than any feature gains.

3.2 evidence/ — checked-in, timestamped run outputs: test log, mutation score, model-check trace, live-origin probe, attack results. Signet does this and it reads as rigour.

3.3 A public status page for all eight origins, refreshed on a cron, showing each publishes a stable key and signs with the key it publishes. deploy/verify-live.mjs already does the check; surface it.

Phase 4 — Make it real (~3 days, biggest credibility delta)

This is what separates you from Jig.

4.1 Replace two invented vendors with real integrations. Shopify is a sponsor and Ilya Grigorik is a judge — a real Shopify store declaring a commitment surface (reserve = cart hold, confirm = checkout, cancel = abandon) is worth more than all six of your fakes. Add a Stripe test-mode charge with a real refund as your compensable vendor. Then "money moves and comes back" is literally true.

4.2 Recruit one external participant. Any other WebMCP hackathon entrant who adds concord.protocol to their site. A single third party declaring a commitment surface proves the "no partnership required" claim in a way six self-authored vendors never can.

4.3 Browser extension that badges any WebMCP site declaring a commitment surface, and warns when an agent is about to call an irreversible tool on a site that declares none. That turns Concord from a demo into something a person installs.

Phase 5 — Presentation (~1 day)

5.1 Cut the README to ~120 lines. Top of file: the 60-second judge path, the live URL, the one-sentence claim, and the attack page. Everything else moves to docs/.

5.2 Move ring0/ to its own repository. Link it as prior work. It's good, and it's costing you.

5.3 Delete experiments/. Git history keeps it.

5.4 Rename shady → meridian throughout so the trick isn't leaked by an id.

5.5 One judge page — /judge — with four buttons: see a refusal, see the surface change, kill the coordinator, verify a receipt elsewhere. No typing.

Why this wins

After Phase 0–5 you'd hold, simultaneously: the deepest cross-origin architecture (6 real origins, more than anyone), the only registration-as-permission model, a filed upstream spec contribution, a machine-checked formal model, 1,200+ tests with a published mutation score, a live attack range, real commercial integrations, and two published npm packages.

Jig beats you today on execution rigour alone. It cannot beat that list — its domain is one workshop, and it proposes nothing upstream.

Two honest cautions. First, Phase 0 matters more than everything after it: if a judge finds the "Committed" bypass in a project whose pitch is verify everything, the irony does more damage than the bug. Second, I couldn't reach your live deployment, so I can't tell you whether A7 is already biting in production. Check /.well-known/concord.json on all six origins right now and confirm the keyId is identical across repeated requests. If it isn't, every receipt you've ever shown a judge failed to verify.