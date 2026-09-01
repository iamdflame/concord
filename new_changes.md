# Concord — Rebuild to Win

**Verified state:** `65a33d8` · 71 files · 9,234 lines · 75 tests (71 pass, 4 dead)
**Goal:** not "a good submission." The one the judges argue about afterwards.
**Constraint removed:** time. This is the full build.

---

# PART I — WHERE YOU ACTUALLY STAND

## What landed (verified by reading the diff, not the commit messages)

| Commit | Fixes my audit § | Verified |
|---|---|---|
| `5e3ff18` Recovery no longer destroys commitments that succeeded | §1.1, §1.2 | ✅ new test at recover.test.mjs:48 — "a confirmed reservation is not cancelled" |
| `61910e8` Close three receipt forgeries and the native-API break | §2.3, §3.1 | ✅ |
| `b4a11b4` Bound the signing endpoint; vendor memory outlives the page | §2.2, §4.3 | ✅ |
| `b24ed73` Deadlines, real reservation TTLs, two silent no-ops | §3.5, §3.6 | ⚠️ **implemented but broken — see below** |
| `ee08090` Durable journal + rule for an unwritable log | §4.1, §4.2 | ✅ and the `mustRecord` fail-closed/fail-open distinction is genuinely excellent |
| `961232f` RFC 8785 canonicalisation | §2.10 | ✅ |
| `56f4b4f` Key validity windows | §2.9 | ✅ |
| `c30ec66` Retry what silence deserves; report policy honestly | §3.3, §3.7 | ✅ terminal-vs-transient error distinction added |
| `a07a83a` Documentation that describes this project | §0.6, §6 | ✅ |
| `65a33d8` **An agent that cannot overpromise** | §0.5 | ✅ **this is the most important commit in the repo** |

That is a serious 3-hour response. The `mustRecord` reasoning — *fail closed when taking on exposure, fail open when giving it back* — is a better articulation of that tradeoff than most production saga implementations have in comments.

## What did not land, and now blocks everything

**1. Deployment. Still zero.**

```
localhost references: 36 → 39   (went UP)
vercel.json netlify.toml Dockerfile render.yaml wrangler.toml .github/workflows Procfile
  → ALL MISSING
```

`kit/vendor.mjs:11` is still `COORDINATOR = 'http://localhost:5173'`. That single constant is the `exposedTo` allowlist. Wrong on a deployed origin and **no vendor tool is reachable by anything.** There is no live URL, which means there is currently no submission.

**2. The new deadline code is dead in Node.** I reproduced it:

```js
const signal = AbortSignal.timeout(200);
const never  = new Promise(() => {});
await Promise.race([never, new Promise((_, rej) =>
  signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }))]);
// → process exits code 13, "unsettled top-level await". The abort never fires.
```

Node's `AbortSignal.timeout()` timer is **unref'd** — it does not hold the event loop open. When the only other pending work is a promise that never settles, Node exits first. A plain `setTimeout` works. This kills `saga.test.mjs:126` and cascades into three more (`cancelledByParent`).

It affects both `probe()` (saga.mjs:97) and `invoke()` (saga.mjs:123). In a browser it works fine — there's no loop-exit concept — so the feature probably functions in the demo. But it is **untested**, and the four tests that would prove it are corpses.

*Fix:*
```js
function deadline(ms, message) {
  let t; const signal = AbortSignal.timeout(ms);
  const promise = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(message)), ms);   // ref'd, holds the loop
  });
  return { signal, promise, clear: () => clearTimeout(t) };
}
```
And **always `clear()` in a `finally`**, or every completed call leaks a live timer for the full timeout duration.

**3. `npm run concord` is still the screenshot tool.** README still calls it "the coordinator."

---

# PART II — THE STRATEGIC REFRAME

Everything below depends on getting this right, so it comes before architecture.

## The problem with the current framing

> "Atomic commitments across independent websites, coordinated in the browser."

Accurate. Also: it sounds like middleware. It makes a judge think *distributed systems homework*. The 15–30% marketplace-margin argument — which is the genuinely great idea here — is buried in paragraph three.

## The framing that wins

> **WebMCP tells an agent what a site can _do_. Nothing tells it what a site can _take back_.**
> **Concord is that missing layer — and the first agent that cannot overpromise.**

Why this specific framing beats the current one, for this specific panel:

1. **It names a gap in the standard itself.** The panel includes the creator of MCP-B (Alex Nahas), Chrome's WebMCP leadership (Sarah Drasner), and OpenAI's browser platform lead (Justin Rushing). These people do not want to see another app. They want to see someone who read the spec closely enough to find what's missing. `inputSchema` describes shape. `readOnlyHint` describes side-effect presence. **Nothing in WebMCP describes side-effect _reversibility_.** That is a true, checkable, non-obvious gap, and you found it.

2. **"An agent that cannot overpromise" is the sentence.** It's already your best commit message. It's concrete, it's emotionally legible, and it inverts the current anxiety about agents. Every other submission will say "our agent can do more." Yours says "ours knows what it must not say." In September 2026 that is the more interesting claim.

3. **It puts the agent at the center**, which the theme requires ("humans and agents… together"), without abandoning the protocol depth.

4. **It survives the skeptic's question.** "Isn't this just 2PC in a browser?" Answer: 2PC assumes a coordinator both parties trust and a homogeneous commit interface. Neither exists on the open web. The contribution isn't the saga — it's **the declaration layer that lets an agent compute the guarantee before anyone is contacted, and refuse when there isn't one.**

## The three sentences for the submission form

> Every site tells an agent what it can do. No site tells an agent what it can undo — so an agent booking a flight on one site and a hotel on another cannot know, before it starts, whether a failure halfway through leaves you with a charge nobody can reverse. Concord is a WebMCP convention that lets any site declare its commitment surface — *hold and release*, *commit and compensate*, or *irreversible* — and an in-browser coordinator that computes what can honestly be promised across several sites **before contacting any of them**, then refuses when the honest answer is that atomicity is not available at any price. The result is the first agent that is structurally incapable of overpromising: not because it was prompted carefully, but because the only tools it can reach will not let it.

## The one thing to stop claiming

"No intermediary" is your weakest line and a sharp judge will pull it. The coordinator *is* an intermediary — it's in the tab, it orders the calls, it assembles the receipt. Lean in instead:

> "The intermediary doesn't disappear. It becomes yours: disposable, margin-free, and unable to lie about what happened, because every statement in the receipt is signed by the counterparty rather than by it."

That's a stronger claim *and* an honest one, and honesty-under-pressure is literally this project's thesis.

---

# PART III — THE REBUILD

## III.1 — Repository restructure

Right now a judge opening the repo sees eleven top-level directories, four of which (`kernel/`, `mail/`, `ledger/`, `pay/`) are a **different project** — the Ring 0 capability kernel. Worse, `kernel/` *also* contains `concord.html`, `concord.mjs`, `agent.mjs`, and `agent-tools.mjs`, which are the actual submission. The most important files in the repo live in a directory named after something else.

**Move Ring 0 out.** Separate repo: `iamdflame/ring0`. Link it from the README as one line: *"Concord was built on a capability kernel — policy, information-flow labels, hash-chained transcript. That's [here](…), and it's a different argument."* You lose nothing (judges were never going to read it) and you gain a repo that is 100% the submission.

Target layout:

```
concord/
├── README.md                    the pitch, in under 400 words above the fold
├── SPEC.md                      ← the protocol, versioned                    NEW
├── ARCHITECTURE.md              ← how it's built, with a diagram             NEW
├── THREAT-MODEL.md              ← what it does and does not defend against   NEW
├── config.mjs                   ← ONE origin table, environment-derived      NEW
│
├── protocol/                    pure logic, zero DOM, 100% unit-tested
│   ├── ladder.mjs               classification + guarantee computation
│   ├── saga.mjs                 phase-ordered executor
│   ├── journal.mjs              write-ahead log + stores
│   ├── recover.mjs              crash recovery
│   ├── receipt.mjs              Merkle + signatures
│   ├── agent-surface.mjs        the four agent tools' semantics
│   └── *.test.mjs
│
├── kit/                         ← THE DROP-IN SDK. Publishable.
│   ├── vendor.mjs               `concord(...)` — 10 lines to participate
│   ├── canonical.mjs            RFC 8785
│   ├── keystore.mjs             stateless, key from env/secret
│   └── vendor.css
│
├── app/                         the coordinator + agent
│   ├── index.html
│   ├── coordinator.mjs
│   ├── agent.mjs
│   ├── agent-tools.mjs
│   └── ui/                      split from the 1,000-line HTML file
│
├── vendors/
│   ├── fly/  stay/  visa/  permit/
│   ├── shady/                   ← the vendor that LIES                       NEW
│   └── byo/                     ← write-your-own, live                       NEW
│
├── verify/                      ← standalone verifier. Publishable.
│   ├── cli.mjs                  npx concord-verify receipt.json
│   └── verify.html              ← drag-and-drop browser verifier             NEW
│
├── spec/
│   ├── declaration.schema.json  ← JSON Schema for concord.protocol           NEW
│   ├── receipt.schema.json                                                   NEW
│   └── conformance/             ← a suite any vendor can run against itself  NEW
│
├── shim/                        WebMCP polyfill (keep — it's honest)
├── deploy/                      ← wrangler/netlify configs per origin        NEW
└── .github/workflows/ci.yml     ← tests + probe on every push                NEW
```

**Why this specific shape matters:** `protocol/`, `spec/`, `kit/`, `verify/` is the directory structure of *a standard with reference implementations*. `kernel/`, `mail/`, `pay/` is the directory structure of *someone's side project*. Judges read layout before they read code.

## III.2 — Kill all 39 hardcoded origins with one file

This is the single highest-value refactor in the whole plan, because it unblocks deployment, and deployment unblocks the submission.

```js
// config.mjs — the only place an origin is ever written
const LOCAL = {
  app:    'http://localhost:5173',
  fly:    'http://localhost:5177',
  stay:   'http://localhost:5178',
  visa:   'http://localhost:5179',
  permit: 'http://localhost:5180',
  shady:  'http://localhost:5181',
  byo:    'http://localhost:5182',
};

const LIVE = {
  app:    'https://app.concord.trade',
  fly:    'https://northwind.concord.trade',
  stay:   'https://rowanhouse.concord.trade',
  visa:   'https://consular.concord.trade',
  permit: 'https://permits.concord.trade',
  shady:  'https://meridian.concord.trade',
  byo:    'https://sandbox.concord.trade',
};

const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
export const ORIGINS  = isLocal ? LOCAL : LIVE;
export const VENDORS  = ['fly', 'stay', 'visa', 'permit'];
export const COORDINATOR = ORIGINS.app;
```

Then:
- `kit/vendor.mjs` imports `COORDINATOR` instead of hardcoding it.
- **Iframes get their `src` from JS**, not from HTML:
  ```js
  for (const id of VENDORS) {
    const f = document.createElement('iframe');
    f.src = ORIGINS[id] + '/'; f.allow = 'tools'; f.id = id;
    f.title = TITLES[id]; f.loading = 'eager';
    frames.append(f);
  }
  ```
- `server.mjs` derives its port table from `LOCAL`.

**Use real subdomains, not `*.netlify.app`.** One domain (~$12/yr). `northwind.concord.trade` and `rowanhouse.concord.trade` *look* like independent businesses; `concord-vendor-2.netlify.app` looks like one person's demo. This is a 10-minute change that materially affects whether the "three independent businesses" claim reads as true. Distinct subdomains are distinct origins — the browser boundary is identical.

## III.3 — Deployment architecture

**Cloudflare Workers, one per origin.** Reasons, in priority order:

1. **It fixes the keystore permanently.** `kit/keystore.mjs` currently writes keypairs to `./.keys/`. On any serverless host that's read-only or ephemeral → keys regenerate per invocation → `/.well-known/concord.json` serves a key that didn't sign the statement → **every receipt fails.** Workers Secrets + WebCrypto makes signing stateless: key in a secret, imported per request, never on disk, never in git.
2. Andrew Galloni (VP Research & Innovation, Cloudflare) is on the panel, and Cloudflare's prize is $10k in credits. Using their platform well is not pandering; it's reading the room.
3. Workers give you the response headers you need (`Origin-Agent-Cluster: ?1`, `Permissions-Policy: tools=(…)`) trivially, and free HTTPS on custom subdomains.

```js
// deploy/vendor-worker.mjs  — one Worker per vendor
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/.well-known/concord.json')
      return json(await wellKnown(env.VENDOR_ID, url.origin, env.SIGNING_JWK), { maxAge: 300, cors: '*' });
    if (url.pathname === '/_concord/sign' && req.method === 'POST')
      return json(await signBounded(env, await req.json()));   // see III.7
    return env.ASSETS.fetch(req);   // static site
  },
};
const HEADERS = {
  'Origin-Agent-Cluster': '?1',
  'Permissions-Policy': `tools=(self "${APP_ORIGIN}")`,
  'Cross-Origin-Resource-Policy': 'cross-origin',
};
```

**Keep `server.mjs`** for local dev — it's 108 dependency-free lines and `npm run dev` working out of the box is a real asset for anyone cloning the repo.

**Add CI** (`.github/workflows/ci.yml`): `npm test` + `npm run probe:concord` headless on every push, with the badge in the README. Green CI on a hackathon repo is rare and reads as seriousness.

## III.4 — SPEC.md: the highest-leverage artifact you can write

This is the thing that moves you from "great project" to "should this be in the standard?"

Write Concord as a **protocol document**, not a description of your code. Structure:

```markdown
# The Concord Commitment Protocol, v1

## 1. Abstract
WebMCP lets a site declare what a tool does. It does not let a site declare
what a tool can undo. This document defines a convention over WebMCP by which
a site declares its commitment surface, and an algorithm by which a coordinator
computes the strongest guarantee available across several such sites before
contacting any of them.

## 2. Terminology                       MUST / SHOULD / MAY (RFC 2119)
## 3. The declaration tool              `concord.protocol`, its exact schema
## 4. The commitment ladder             rungs, and how a declaration maps to one
## 5. Guarantee computation             the four outcomes, normatively specified
## 6. Phase order                       reserve → execute → commit → confirm
## 7. Idempotency keys                  derivation, stability, lifetime
## 8. The status probe                  `concord.status`, MUST perform nothing
## 9. Attestation                       the statement, canonicalisation, signing
## 10. Key publication                  /.well-known/concord.json, validity windows
## 11. The receipt                      Merkle construction, inclusion proofs
## 12. Verification                      the exact algorithm a verifier MUST run
## 13. Conformance levels                L1 declares · L2 recoverable · L3 attesting
## 14. Security considerations           → THREAT-MODEL.md
## 15. Open questions                    honest, and see below
```

**Section 15 is where you win points, not lose them.** Write the unresolved problems down:

- *A vendor may declare `compensable` and simply refuse to compensate.* Concord cannot prevent this. It can only make the lie attributable — the failed compensation is recorded, and the vendor's own signature is on its earlier statement. **Concord converts an unenforceable promise into an attributable one. That is the actual contribution and it should be stated plainly rather than hedged.**
- *Confirm fan-out is not atomic.* With three reservable vendors, confirm #3 can fail after #1 and #2 committed. No in-tab protocol fixes this; it needs vendor-side prepared-transaction semantics. Say so.
- *Nothing binds a vendor's statement to the receipt's completeness.* (See III.8 — you should close this one.)
- *The coordinator sees every vendor's price.* Selective disclosure protects vendors from each other, not from the coordinator.

Judges of this calibre have seen a hundred projects that overclaim. A spec with a candid "Open questions" section is disarming, and it makes every claim you *do* make more credible.

**Then file the upstream issue.** On `github.com/webmachinelearning/webmcp`, propose:

```js
annotations: {
  readOnlyHint: false,
  commitment: 'reservable' | 'compensable' | 'irreversible',
  reverses: 'tool_name',        // for compensate/cancel
  ttlSeconds: 900,              // for reserve
}
```

Argue: `readOnlyHint` already establishes that WebMCP cares about the *category* of a tool's effect; reversibility is the next axis, and an agent needs it to plan safely. Link the issue from your README and your submission. **A judge who is a spec editor seeing their own repo linked from a submission is the single strongest signal you can send.** Worst case it's ignored. Best case a judge replies before judging closes.

## III.5 — The agent, done properly

What exists now (`app/agent.mjs`) is a regex vendor-matcher with an optional Chrome built-in `LanguageModel` path. It's honest about which brain it's using, which is good. It is not yet the star.

**Design principle: the agent must be replaceable and still safe.** That's already your thesis — "the constraint is in the shape of the surface rather than in anyone's instructions." Make the demo *prove* it.

### The four tools (refine what's there)

```js
concord_list_vendors()
  → who is present, what each can commit to, contacts nobody

concord_propose({ vendors: [...], details: {...} })
  → the computed guarantee, the ordering, the point of no return,
    the caveats, and a proposalId. CONTACTS NOBODY.
    On an impossible set: { refused: true, because: "...", instead: "..." }

concord_commit({ proposalId, acknowledgedGuarantee })
  → executes. MUST refuse if acknowledgedGuarantee ≠ the computed one.
    This is the interlock: an agent physically cannot commit
    without first having read the guarantee back.

concord_explain({ proposalId })
  → plain-language, for the agent to relay to the human
```

The `acknowledgedGuarantee` interlock is the best idea in the agent surface and it should be *foregrounded*, not buried. It means: **an agent cannot commit without having said the guarantee out loud first.** Not "we prompted it to." It cannot. Put that in the README, the video, and the spec.

### Add a fifth tool

```js
concord_what_stands({ sagaId })
  → after the fact: what actually stands right now, per vendor,
    with the receipt root. Distinct from what was asked for.
```

Because the failure mode of agentic commerce isn't the booking — it's the agent *reporting* success it didn't achieve. This tool makes "what actually happened" a first-class queryable thing rather than something the agent narrates from memory.

### The multi-brain demonstration

Ship three interchangeable drivers, selectable in the UI:

1. **Deterministic reader** (regex) — always available, offline, reproducible for judging
2. **Chrome built-in** `LanguageModel` — on-device, no key
3. **ChatGPT's in-app browser agent** — the native path

and label which is active, prominently. Then the killer line in the video:

> "Switch the brain. The refusal doesn't change. It isn't a prompt — it's the shape of the tools."

That single demonstration answers the "is the safety just prompt engineering?" question permanently, and it is the question every one of these judges will have.

## III.6 — Two new vendors that create real separation

### `vendors/byo/` — write your own vendor, live

The #1 skeptical thought a judge has watching this: *"is this three hardcoded fake sites talking to each other?"*

Kill it. A page on its own origin (`sandbox.concord.trade`) with a code editor pre-filled with:

```js
import { concord } from 'https://kit.concord.trade/v1.mjs';

concord({
  id: 'lounge',
  title: 'Skyline Lounge',
  steps: {
    reserve: { tool: 'hold_pass', ttlSeconds: 600, run: async ({ guests }) => ({ ref: id(), guests }) },
    confirm: { tool: 'issue_pass', run: async ({ ref }) => ({ ref, issued: true }) },
    cancel:  { tool: 'drop_hold',  run: async ({ ref }) => ({ ref, released: true }) },
  },
});
```

Hit **Run**. It registers over WebMCP. The coordinator's `toolchange` listener fires. **The ladder re-derives live and the guarantee updates on screen.** Delete the `cancel` step, hit Run again, and watch the guarantee drop from `atomic` to `bounded` — or to `refused` if it collides with the consular fee.

This is the most persuasive thirty seconds you can possibly build. It converts "a demo" into "a protocol" in front of the judge's eyes, and it makes "no API partnership" a thing they *watched* rather than read.

*Implementation note:* serve the editor's code from the sandbox origin via a `srcdoc` iframe or a `?src=` param that the sandbox origin evaluates. It must be a genuinely distinct origin from the app for the WebMCP boundary to be real.

### `vendors/shady/` — the vendor that lies

Meridian Holdings. Declares `compensable` — `execute` + `compensate` — and its `compensate` **always fails**.

Run a commitment including it. The hotel books, Meridian books, the consular fee fails, unwind begins — and Meridian's compensation fails. Concord does not pretend:

```
compensate_failed   meridian · "no reversal available for that reference"
IN DOUBT            meridian holds $412 that it declared it could return
                    and did not. Someone has to fix this by hand.
```

Then the payoff: **open the receipt.** Meridian's own signed statement is in it, saying it executed. It cannot deny the charge. Its declared-but-unhonoured `compensable` claim is now a documented, attributable breach with its own signature on it.

> "Concord cannot stop a vendor from lying. It can make sure the lie has a name on it."

That's the line. It's the honest limit of the design *and* the strongest argument for why the receipt exists. Most projects hide their limits; showing yours as a feature is what separates a submission from a submission that wins.

## III.7 — Close the last security gaps

### The signing endpoint

Commit `b4a11b4` bounded it. Verify it enforces all of:
- **Same-origin only** — check `Sec-Fetch-Site: same-origin`, reject otherwise. Do not rely on CORS preflight failing by accident.
- **Statement must match a performed action** — the server should look up the idempotency key in its own record and sign *its own* view, not the client's payload. Right now the page hands the server a statement. That is still an oracle, just a fenced one.
- **Rate limit** per key.

Ideal end state: `POST /_concord/sign { idempotencyKey }` → server retrieves what it did under that key and signs *that*. The page can no longer influence the content at all. That closes the XSS→forgery chain structurally rather than by escaping.

### Output escaping in vendor `render()`

Independently of the above: `fly.mjs`, `visa.mjs`, `stay.mjs` interpolate tool arguments into `innerHTML`. Move to `textContent` or a tagged-template escaper. There is no runtime schema validation in the vendor path (`kit/vendor.mjs` calls `spec.run(args)` with raw args, bypassing `dispatch.mjs`'s `validate()`), so `type: 'number'` is not enforced.

**Add schema validation in the kit**, before `run`. Ten lines with a minimal JSON-Schema subset, or bundle a tiny validator. It closes the XSS class *and* it's the right behaviour for a tool surface an untrusted agent drives — which is exactly what WebMCP's own security guidance calls for. That's a point you can make in the video.

### The shim's reply path

`shim/webmcp.mjs:107` resolves pending promises without checking `e.origin` against the origin the request was sent to, and IDs are sequential and predictable. Bind each pending entry to its target origin and compare on reply. It only matters for the shim (native Chrome mediates this), but a judge who reads the shim will check.

## III.8 — Close the last receipt hole: cardinality

Attacks 1 and 2 from my audit are closed. Attack 3 is not:

```
full receipt    entries: 2  verifies: true
trimmed receipt entries: 1  verifies: true    ← coordinator dropped the inconvenient one
```

Nothing commits to *how many* statements a saga produced, so a coordinator can silently drop one.

**Fix — the plan digest.** Before phase 1, the coordinator computes:

```js
planDigest = sha256(canonical({
  sagaId,
  parties: planned.order,              // ['fly','stay','visa']
  guarantee: planned.guarantee,        // 'bounded'
  steps: expectedStepList,             // ['fly.reserve','stay.execute','visa.execute','fly.confirm']
}))
```

It passes `planDigest` to every vendor with every call, and **every vendor includes it in the statement it signs.** Now:

- A verifier recomputes the expected step list from `parties` + `guarantee` and checks the receipt contains exactly those entries.
- Dropping an entry → the count no longer matches the digest every *surviving* vendor signed. **The remaining vendors' own signatures testify to the existence of the missing one.**
- Cross-saga stitching (Attack 1) is closed twice over.

This is elegant and cheap: one extra field in the statement, one extra check in the verifier. It's also a genuinely nice cryptographic idea — *each participant attests to the shape of the whole* — and worth its own paragraph in SPEC.md.

## III.9 — The verifier as a product

Currently `tools/verify-receipt.mjs`, run via `npm run verify`. Two upgrades:

**1. Publish it.** `npx concord-verify receipt.json`. Zero-install. A judge can verify a receipt on their own machine, from your published package, with nothing of yours running. That's an extraordinary trust signal and it takes an afternoon.

**2. `verify/verify.html` — drag and drop.** A single static page, hosted on a *fourth* origin. Drop the receipt JSON on it. It fetches each vendor's key from that vendor's origin over TLS and renders per-statement results. Judges who won't open a terminal will use this.

Make both handle malformed input gracefully — the current CLI stack-traces on an empty `entries` array (`Error: a receipt needs at least one entry` with a full trace). The tool a vendor runs in a dispute must never stack-trace.

Add a `--explain` flag that prints the verification algorithm as it executes, step by step. It turns the verifier into a teaching artifact.

## III.10 — The UI rebuild

The current design language — dark ground, IBM Plex Mono, restrained accent palette, thin rules — is good. Restrained and technical, which suits the content. Keep the palette. Fix the rest.

### Fix first: semantics and accessibility

`kernel/concord.html` had **zero** `<h1>`, `<main>`, `role`, or `aria-live`. In a live-updating execution log, no `aria-live` means the entire demo is invisible to assistive tech.

```html
<html lang="en">
<body>
  <header role="banner">…</header>
  <main>
    <section aria-labelledby="promise-h">
      <h1 id="promise-h">What can be promised</h1>
      <output id="verdict" aria-live="polite"></output>
    </section>
    <section aria-labelledby="exec-h">
      <h2 id="exec-h">Execution</h2>
      <div id="run" role="log" aria-live="polite" aria-relevant="additions"></div>
    </section>
  </main>
  <aside aria-labelledby="parties-h"><h2 id="parties-h">The participants</h2>…</aside>
</body>
```

Also: focus management when the plan changes, `prefers-reduced-motion` honoured on every animation, visible focus rings (you have `:focus-visible` already — good), and a real skip link.

Sarah Drasner is on this panel. Chrome DevRel leadership notices accessibility. This is a two-hour fix that directly serves the "complete, coherent product experience" criterion.

### Then: make the guarantee the hero

The guarantee verdict is the whole thesis and it currently renders as a 20px heading. Give it the entire top third of the screen. Make it *typographically enormous*:

```
       ATOMIC UP TO A FINAL COMMIT

  Everything reversible is settled first. One irreversible
  step runs last, and a failure there unwinds the rest.

  ┌─ 1 ─ Northwind Air ──── ████████████ reservable ─────────┐
  │  2 ─ Rowan House ────── ███████░░░░░ compensable         │
  │  3 ─ Consular Fee ───── ███░░░░░░░░░ irreversible  ◀ PONR│
  └──────────────────────────────────────────────────────────┘
```

And when it's `REFUSED`, the whole panel should go red and the Commit button should not merely disable — it should be **replaced** by the refusal text. The refusal is the emotional peak; render it like one.

### Then: the timeline

Replace the flat event log with a **phase timeline** that fills left-to-right, with the point-of-no-return as a hard vertical rule you watch the run approach. Before it: everything is drawn in "reversible" colour. After it: the bar changes colour permanently. That single visual makes the phase-ordering argument without a word of narration — and phase ordering is the safety property.

### Then: the states you're missing

Your own README lists these as unfinished: *"empty states, first run, mid-flight cancel, refresh."* Build them:

- **First run** — a one-time overlay: "Four independent businesses. No API between them. Watch what an agent is allowed to promise."
- **Loading** — a real skeleton during the `awaitTools` window, not a static string
- **Partial discovery** — if 3 of 4 vendors answered, *say so* and name the missing one. Currently `awaitTools` resolves on timeout with whatever it has, and the plan is computed over an incomplete set with no warning. That's a correctness bug wearing a UX costume.
- **Mid-flight cancel** — a Stop button. For a system whose premise is "cancellation as a first-class primitive under the user's authority," the user having no cancel button is an irony a judge will enjoy pointing out. Wire it to an `AbortController` threaded through `runSaga`.
- **Error boundary** — `app/coordinator.mjs` is a top-level-await module. Any throw during init renders a **blank page**. Wrap init in try/catch and render a real failure state. This is what a judge sees if one vendor is slow to boot.

### Then: the receipt panel

Make the Merkle tree *visible*. Draw it. Show the two opaque sibling hashes that `fly` uses to verify its own leaf, and grey out the leaves it cannot see. Selective disclosure is a subtle idea that becomes obvious the instant it's drawn.

## III.11 — Testing and proof

You have 75 tests. Target for the rebuild:

**1. Fix the four dead ones** (III, Part I). Non-negotiable — a `not ok` in the output is worse than not having the test.

**2. Property-based tests** for the ladder. Generate random participant sets and assert invariants:
- an irreversible participant is always last or the plan is refused
- two irreversible participants always refuse
- refused plans contact nobody, ever
- ordering always respects declared dependencies

`fast-check` is one dev dependency and turns "we tested some cases" into "we proved the invariant over thousands of generated cases." That's a sentence worth having in the README.

**3. A crash matrix, exhaustive and honest.** For every (vendor set × crash point × before/after) triple, assert the final real vendor state equals the expected state. Your current world-model in `recover.test.mjs` tracks reversals but not vendor state — which is exactly why the old bug hid there. **Model actual vendor state in the test double** (seat held/ticketed, hotel charged/refunded), and assert on *that*. Print the matrix as a table in CI output.

**4. Conformance suite** (`spec/conformance/`). A suite any third-party vendor can run against its own implementation to check it's Concord-compliant. Ship it, document it, and run your own four vendors through it in CI. This is what turns a spec into an adoptable one.

**5. The adversarial suite.** Codify my three receipt attacks (plus cardinality) as tests that must *fail to verify*. A test file literally named `receipt.forgery.test.mjs` where every test asserts an attack is caught is enormously persuasive to a security-minded reader.

**6. Native-API test.** A probe run against real Chrome 149+ with `--enable-features=WebMCP` (or the flag), in CI via a container. Even one green assertion against the native API destroys the "shim-only, unproven" caveat that currently sits in your README.

---

# PART IV — THE DEMO, BEAT BY BEAT

Three minutes. Judges are not required to watch past it. Every second is contested.

## The beat sheet

**0:00–0:12 — The gap. No preamble, no logo.**

> "WebMCP lets a website tell an agent what it can do."
> *[screen: a `registerTool` call]*
> "Nothing lets it say what it can undo."
> *[the word `undo` lands alone on screen]*

**0:12–0:30 — Why that costs money.**

> "So an agent booking a flight on one site and a hotel on another can't know, before it starts, whether failing halfway leaves you with a charge nobody can reverse. That's why Booking.com and Expedia exist — they're the coordinator two sites can't have. They take fifteen to thirty percent for standing there."

**0:30–0:50 — The declaration.**

> "Concord adds one tool: `concord.protocol`. A site declares what it can commit to — hold and release, commit and compensate, or irreversible. Four independent businesses, no API between them, none knows the others exist."
> *[four vendor pages, four distinct domains visible in the frame]*

**0:50–1:20 — Act 1: the agent proposes, and is interlocked.**

> "I ask for a flight, a hotel, and the visa fee."

Agent calls `list_vendors` → `propose`. The guarantee renders huge: **ATOMIC UP TO A FINAL COMMIT**. Agent reads it back.

> "It can't skip that. `commit` refuses unless the guarantee it acknowledges matches the one that was computed. The agent physically cannot commit without having said out loud what it's promising."

**1:20–1:45 — Act 2: the refusal. Slow down here.**

> "Now I add the entry permit. Two irreversible steps."

Screen goes red. **NO HONEST PROMISE AVAILABLE.**

> "If the second fails, nothing can undo the first. So it doesn't try. It says so, and it tells me what it *can* do instead — run them as two separate decisions. Nothing was contacted. That refusal was computed from declarations alone, before anyone was touched."

*This is the moment. Let it breathe for a full beat.*

**1:45–2:15 — Act 3: break it live.**

Back to the working plan. Commit. Mid-run, flip **break confirm** on the hotel.

> "I'm breaking the hotel while it's running."

Watch on the vendors' own pages: the fee is refunded, the seat released, the ledger returns to zero.

> "Every reversal happened on the vendor's own site, driven by tools the vendor published. Nothing here has a backend."

**2:15–2:40 — Act 4: the stranger's vendor.**

> "None of this is hardcoded."

Open the sandbox. Type a fifth vendor in ten lines. Run. It appears. The ladder re-derives. Delete its `cancel` step, run again — the guarantee **downgrades on screen**.

> "That site was written thirty seconds ago and has no agreement with anything else here."

**2:40–2:58 — The receipt.**

Export. Terminal. `npx concord-verify receipt.json`.

> "Nothing of mine is involved. It fetches each vendor's key from that vendor's own origin and checks every statement was signed by the party it names."

```
✓ fly     reserve   in tree yes   signed yes
✓ stay    execute   in tree yes   signed yes
✓ visa    execute   in tree yes   signed yes
✓ fly     confirm   in tree yes   signed yes

VERIFIED — 4/4 signed by the party named.
```

> "An agent that cannot overpromise, and a receipt that doesn't need you to trust it."

## Production notes

- **Real audio, spoken by you.** The rules require audio. Do not use TTS; a human voice with conviction on a thesis this specific reads as authorship.
- **Say "WebMCP" and name the APIs** — `registerTool`, `getTools`, `exposedTo`, `fromOrigins`, `allow="tools"` — at least twice. One criterion is literally *WebMCP Leverage*; make it trivially easy to score.
- **Show the URL bar** on each vendor. Distinct domains are the proof of independence.
- **No slides.** Everything on real screens.
- **Captions burned in.** Judges may watch muted first.
- **Record at 1440p+**, crop tight on text. Small type on a shared screen is how good demos die.
- **Cut a 45-second version too** for the Devpost gallery thumbnail and for social. The `@OpenAIDevs` spotlight is part of the prize; give them something clippable.

---

# PART V — THE SUBMISSION PACKAGE

## README (above the fold — the first 400 words decide everything)

Order:
1. **The one-line gap.** *"WebMCP tells an agent what a site can do. Nothing tells it what a site can take back."*
2. **Live URL. Enormous. First interactive thing on the page.**
3. **A GIF** of the refusal moment. Autoplaying, 6 seconds, loops. Most judges will not clone.
4. **Three bullets** — the ladder, the interlock, the receipt.
5. **`npx concord-verify`** — one command, verifiable by a stranger.
6. CI badge, test count, licence.
7. *Then* the depth.

Move "What Phase 01 does not prove" and "Next: Phase 05" **out of the README** and into `STATUS.md`. The candour is admirable and I don't want you to lose it — but a README that ends on what's unfinished is scored as unfinished. Link it: *"Known limits and open questions: STATUS.md."* Same honesty, correct placement.

## The text description (four required answers)

**Why this use case is a strong fit for WebMCP** — Because it needs exactly the thing WebMCP uniquely provides and nothing else does: two mutually distrusting origins' authenticated, typed capabilities live in one execution context under the user's authority. Not scraping, not an API partnership — `exposedTo` and `fromOrigins` are consent on both sides, enforced by the browser. Then name the gap you're filling.

**How it creates a better user experience** — The agent tells you what it can promise *before* it acts, refuses when the honest answer is "nothing," and hands you a receipt you can verify without trusting it. Contrast with the status quo: an agent that books three things and tells you it went fine.

**What people and agents can do together that was difficult or impossible before** — Commit atomically across businesses that have no relationship, no shared coordinator, and no reason to trust each other, with the failure semantics computed in advance. Today this requires a marketplace charging 15–30%. *(Source these figures in the submission — they carry weight and they'll be checked.)*

**How you implemented WebMCP** — Be specific and technical. `registerTool` with `exposedTo` for cross-origin consent; `getTools({fromOrigins})` for discovery; `executeTool` with JSON-string arguments per spec; `toolchange` for live re-derivation when a vendor appears; `allow="tools"` plus `Permissions-Policy` for delegation; `Origin-Agent-Cluster: ?1` for the origin isolation the API requires; `annotations.readOnlyHint` on probes that perform nothing. Mention the shim and be honest about what it does and doesn't prove — then point at the green native probe.

## What to have ready that isn't required

- **THREAT-MODEL.md** — nobody else will have one
- **The upstream WebMCP issue**, linked
- **An architecture diagram** — one image, the four origins and the tool calls between them
- **`npx concord-verify`** published
- **CI green**

---

# PART VI — BUILD ORDER

Dependency-ordered. Each phase leaves the project in a shippable state.

### Phase A — Unblock (nothing else matters until this is done)
1. `config.mjs`; delete all 39 hardcoded origins; iframes get `src` from JS
2. Stateless keystore (key from env/secret, never disk)
3. Deploy 5 origins on real subdomains over HTTPS; verify headers survive
4. Fix the `AbortSignal.timeout` deadline bug; four dead tests green
5. **Open the live URL in ChatGPT's in-app browser and run it end to end.** Fix whatever breaks. This is the judging environment and it is still unproven.
6. Fix `npm run concord`

### Phase B — Structure
7. Move Ring 0 to its own repo
8. Restructure to `protocol/ kit/ app/ vendors/ verify/ spec/`
9. Split the 1,000-line `concord.html`
10. CI: tests + headless probe

### Phase C — The separation features
11. `vendors/shady/` — the vendor that lies
12. `vendors/byo/` — write-your-own, live, with `toolchange` re-derivation
13. Plan digest → close the cardinality forgery
14. `concord_what_stands` tool
15. Three interchangeable agent brains with a visible selector

### Phase D — The artifacts
16. SPEC.md
17. THREAT-MODEL.md, ARCHITECTURE.md, STATUS.md
18. `spec/conformance/` + run own vendors through it in CI
19. Publish `concord-verify` to npm; build `verify.html`
20. File the upstream WebMCP issue

### Phase E — The surface
21. Accessibility pass — landmarks, `aria-live`, focus, reduced-motion, `lang`
22. Guarantee-as-hero redesign
23. Phase timeline with the point-of-no-return rule
24. Empty / loading / partial-discovery / error states
25. Mid-flight cancel
26. Merkle tree visualisation
27. First-run overlay

### Phase F — Proof
28. Property-based ladder tests (`fast-check`)
29. Crash matrix with modelled vendor state
30. `receipt.forgery.test.mjs`
31. Native-Chrome probe in CI

### Phase G — Submission
32. README rewrite
33. Architecture diagram + refusal GIF
34. Record the video (expect 6–10 takes; the refusal beat needs to land)
35. Write the four answers
36. Submit early enough to test the live URL from a clean machine and network

---

# PART VII — WHAT WILL BE USED AGAINST YOU

Pre-empt each of these *in the submission itself*. Answering an objection before it's raised is worth more than answering it well afterwards.

| Objection | Your answer |
|---|---|
| "This is just 2PC / sagas in a browser." | 2PC needs a coordinator both parties trust and a shared commit interface. Neither exists across independent sites. The contribution is the **declaration layer** — computing the guarantee from what sites say about themselves, before contact — and the **refusal** when none exists. The saga is the easy part. |
| "The vendors are fake." | Watch a judge write one live in the sandbox and join the commitment. Plus a published conformance suite anyone can run. |
| "A vendor can just lie about being compensable." | Correct, and Concord cannot prevent it. Meridian does exactly that on camera. What Concord does is make the lie **attributable** — the vendor's own signature is on the statement it later fails to honour. Stated plainly in SPEC.md §15. |
| "The safety is prompt engineering." | Swap the brain live. The refusal is identical, because it's in the tool surface, not the instructions. The `acknowledgedGuarantee` interlock makes committing-without-disclosing structurally impossible. |
| "You still have an intermediary." | Yes — yours, disposable, margin-free, and unable to misreport because every statement is signed by the counterparty. Say it first. |
| "It only works on the shim." | Green native probe in CI, plus a recorded run in ChatGPT's in-app browser. **Currently your biggest exposure — fix it in Phase A.** |
| "Confirm fan-out isn't atomic." | Documented in SPEC.md §15 as an open question with the reason no in-tab protocol can fix it. Being first to say it costs you nothing and buys you credibility. |

---

# PART VIII — WHAT NOT TO DO

Things that feel like improvements and aren't:

- **Don't add more vendors.** Four plus the liar plus the sandbox is already more than a 3-minute video can hold. A fifth honest vendor adds nothing.
- **Don't build a real payments integration.** It adds risk, keys, and compliance surface, and buys zero points. The fake ledgers are fine *because* the receipt is real.
- **Don't chase a big LLM.** Chrome's built-in model plus the deterministic reader is stronger — it's offline, reproducible for judges, and it makes the "the brain doesn't matter" argument for you. An OpenAI API key in a judged demo is a liability, not a flex.
- **Don't keep Ring 0 in the repo** because it was hard work. It was, and it's the wrong repo. Link it with pride from one line.
- **Don't soften SPEC.md §15.** The open questions are load-bearing.
- **Don't polish the UI before Phase A is done.** A beautiful demo on `localhost:5173` scores zero.

---

# CLOSING

You already have the hard part. The commitment ladder is a real idea. The `acknowledgedGuarantee` interlock is a real idea. Separating the leaf hash from the signature so the receipt can distinguish *"this was altered"* from *"this vendor never said that"* is a subtle piece of design most people get wrong. `mustRecord` — fail closed taking on exposure, fail open giving it back — is a distinction I have seen production systems get wrong. Refusing to invent a `compensate` for a statutory fee is the restraint the whole project is arguing for, demonstrated rather than described.

What you don't yet have is the thing that converts all of it into a win: **a stranger's ability to verify it without you in the room.** A live URL they can open. A vendor they can write themselves. A receipt they can check with your code but not your server. A spec they can read and disagree with.

The gap between this and the winning submission is not more protocol. It's deployment, one editable sandbox, one dishonest vendor, and a spec document.

Deploy first. Everything else compounds from there.