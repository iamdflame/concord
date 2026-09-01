# Concord — Complete Problem Audit

**Repo:** `github.com/iamdflame/concord` @ `536edb6` · 15 commits · 5,846 lines · MIT · 0 stars
**Target:** The WebMCP Challenge (OpenAI/Devpost) · **Deadline: Sep 3, 2026, 1:00pm PDT**
**Audited:** Sep 1, 2026 — you have **~2 days**.

Everything below was verified by reading the source, running the test suite, executing
proof-of-concept exploits against the real modules, and checking the code against the
published WebMCP spec and the hackathon's official rules. Where I claim a bug, I ran it.

---

## 0. The headline

The protocol design is genuinely good. The commitment ladder, the phase ordering, the
write-ahead journal, and the Merkle receipt with separated statement/signature hashing are
real engineering with real thought behind them. The README is the best-written hackathon
README I have read.

That is the problem. **The quality of the prose is currently writing cheques the code
cannot cash**, and the project's own stated standard — "the hard part is refusing to lie" —
is the standard it fails against. There are four separate places where the system reports
success or safety in a situation where money has actually been lost or a guarantee has
actually been broken.

Separately, and more urgently: **as submitted, this cannot be judged.** It has no live
URL, cannot be deployed without editing 36 hardcoded lines, has no demo video, has no AI
agent anywhere in it, and does not work on the native WebMCP API that judges will use.

Three buckets:

| | Count | Fixable in 48h? |
|---|---|---|
| **Submission blockers** (project cannot be scored) | 7 | Yes — must be |
| **Correctness bugs that falsify the README's central claims** | 11 | Partially |
| **Security, robustness, spec, docs** | 40+ | Some |

---

# TIER 0 — SUBMISSION BLOCKERS

These are not code-quality opinions. Each one is a written requirement in the official
rules. Any one of them can drop you at **Stage One**, which the rules define as a
**pass/fail gate** before judging even begins.

### 0.1 — There is no live URL. This is the single biggest problem.

The rules, twice, in Requirements and in §4:

> "Provide a **working live URL** that judges can access using ChatGPT's in-app browser or
> Google Chrome with WebMCP enabled."

Concord runs on **seven hardcoded localhost ports** (5173–5179). There is no deployment
config of any kind:

```
MISSING vercel.json     MISSING netlify.toml    MISSING Dockerfile
MISSING render.yaml     MISSING wrangler.toml   MISSING Procfile
MISSING .github/workflows                       MISSING .env.example
```

I counted **36 hardcoded `http://localhost:PORT` references** across `.mjs` and `.html`
files. The critical ones:

| File | Line | What breaks |
|---|---|---|
| `kit/vendor.mjs` | 11 | `COORDINATOR = 'http://localhost:5173'` — this is the `exposedTo` value. Wrong here and **no vendor tool is reachable at all.** |
| `kernel/concord.mjs` | 18 | `FLY/STAY/VISA` — the `fromOrigins` list |
| `kernel/concord.html` | 151–153 | The three `<iframe src>` |
| `kernel/concord-test.html` | 35–37 | Same, in the probe harness |
| `server.mjs` | 18–28 | The whole origin table |

Note the architecture makes this harder than a normal deploy: WebMCP's cross-origin story
requires the vendors to be **genuinely different origins**, so you need **four separate
deployments** (coordinator + 3 vendors) on four distinct HTTPS hostnames, with the
`Origin-Agent-Cluster` and `Permissions-Policy` headers preserved on each.

**Also:** `fromOrigins` and `exposedTo` "only support **secure origins**" per the Chrome
docs. `http://localhost` is special-cased as potentially-trustworthy, so it works locally,
but every deployed origin must be HTTPS. Netlify/Vercel/Render all give you that free.

### 0.2 — The signing keys break on every serverless host

`kit/keystore.mjs` generates ECDSA keypairs on first use and writes them to `./.keys/`
(which is gitignored). On Vercel/Netlify Functions the filesystem is read-only or
ephemeral per-invocation. Result: **`writeFile` throws, or keys regenerate per request** →
`/.well-known/concord.json` serves a different key than the one that signed the statement
→ **every receipt fails verification.** The receipt is your best feature and it is the
thing that breaks first on deploy.

Fix: commit fixed test keypairs, or read them from env vars, or deploy on a host with a
real filesystem (Render, Fly, a container).

### 0.3 — No demo video

> "must be less than three (3) minutes... must include a clear demo of your project
> functioning **and with audio** that covers what you built and how you used WebMCP...
> must be uploaded to and made publicly visible on **YouTube**"

Nothing in the repo, and nothing linked. This is mandatory. Note the phrasing "Judges are
not required to test the Project and may choose to judge based solely on the text
description, images, and video" — **for many judges the video will be the entire
submission.** It is not a formality; it is likely your primary judged artifact.

### 0.4 — The literal code pattern the rules ask for is absent from the repo

The rules list, as a repository requirement:

```js
document.modelContext.registerTool({
  name: "search_products", description: "...", inputSchema: {...}, execute: async (input) => {...}
});
```

I grepped the entire repo. **The string `document.modelContext.registerTool` does not
appear anywhere.** Every registration goes through the adapter indirection:

```js
const { ctx } = await resolveModelContext();
await ctx.registerTool({...}, { exposedTo: [COORDINATOR] });
```

Functionally equivalent, and arguably better engineering. But if Stage One screening is
partly automated (the rules explicitly permit "automated AI-driven analysis"), a grep for
the canonical pattern returns nothing. Cheap insurance: add one direct
`document.modelContext.registerTool(...)` call, or at minimum a README code block showing
the canonical form.

### 0.5 — There is no agent. The theme is human + agent collaboration.

The hackathon's one-line brief:

> "Build a WebMCP-powered web app that imagines and explores the future of the open web —
> where humans and **agents** can interact, collaborate, and create together."

And: "an app that becomes meaningfully better when people **and their agents** can use it
together."

Concord has **no LLM, no agent, and no ChatGPT integration.** The "coordinator" is a
hand-written orchestration script in `kernel/concord.mjs` that runs a fixed four-scenario
menu with hardcoded inputs:

```js
const INPUTS = {
  fly:  { route: 'LOS-LHR', date: '2026-10-04' },
  stay: { nights: 3, city: 'London' },
  visa: { applicant: 'D. Flame', country: 'GB' },
};
```

There is no natural-language surface, no tool-selection by a model, nothing an agent
drives. You have built an excellent **distributed-transaction protocol that happens to use
WebMCP as an RPC transport.** That is a different thing from what was asked for, and
"WebMCP Leverage" is one of four equally weighted criteria.

This is the deepest strategic problem in the submission and I'd argue it's more important
than any individual bug.

### 0.6 — Repo README is written for a different project

Someone landing on the repo (which is a graded artifact — "All necessary source code,
assets, and instructions required for the project to be functional") gets this Layout
section:

```
server.mjs          two origins with Origin-Agent-Cluster and Permissions-Policy
kernel/             :5173 — Ring 0 and the phase suites
mail/               :5174 — untrustedContentHint; authors none of what it returns
ledger/             :5175 — read-only; the corroborating party
pay/                :5176 — send_funds, irreversible, the effect being guarded
```

`server.mjs` serves **seven** origins, not two. Its own header comment references a
`workload/` directory that does not exist. And the Layout **documents the Ring 0 kernel
demo and omits Concord entirely** — `concord/`, `kit/`, `vendors/`, and `synth/` are not
listed at all, even though `vendors/` and `concord/` *are* the submission.

The README also ends on "**What Phase 01 does not prove**" and "**Next: Phase 05...**",
which frames the whole thing as an unfinished internal research programme rather than a
finished submission. Judges scoring "Execution — a complete, coherent product experience,
not just a technical proof of concept" will read that section as a self-assessment of
incompleteness.

### 0.7 — Documented commands are wrong

```
npm run dev            # seven origins    ✓ correct
npm run concord        # the coordinator  ✗ WRONG
```

`npm run concord` resolves to:

```json
"concord": "URL=http://localhost:5173/concord.html node tools/shot.mjs"
```

`tools/shot.mjs` is a **headless-Chrome screenshot utility.** It spawns `google-chrome`
over CDP and writes a PNG. A judge following your quickstart runs it, gets either a PNG or
a spawn error (if Chrome isn't at `google-chrome` on PATH — it isn't on macOS), and
concludes the project is broken. The correct instruction is the sentence immediately after
("open http://localhost:5173/concord.html"), which makes the labelled command pure noise.

Also `npm run verify receipt.json` crashes with an unhandled stack trace rather than an
error message when handed a malformed receipt:

```
Error: a receipt needs at least one entry
    at buildTree (receipt.mjs:47:29)
```

This is the tool a vendor in a dispute is supposed to run. It should not stack-trace.

---

# TIER 1 — CORRECTNESS BUGS THAT FALSIFY THE README'S CENTRAL CLAIMS

These are the ones that matter most, because the README stakes the project's identity on
not doing exactly these things.

### 1.1 — 🔴 CRITICAL: Recovery destroys successfully completed transactions

**This is the worst bug in the project, and it is in the flagship feature.**

`Journal.incomplete()` (journal.mjs:90) selects sagas where `settled === null`. The
`settled` marker is written *after* the final step (saga.mjs:207). So a coordinator that
dies **between the last successful call and the settled write** leaves a saga that looks
identical to one that died mid-flight.

`recover()` (recover.mjs:56) then reverses everything in `happened` — and `happened`
includes every `reserve` and `execute` that completed, **with no awareness that a
subsequent `confirm` already turned them into final bookings.**

I ran it. Trip scenario, coordinator dies after all four calls succeed:

```
plan order: fly -> stay -> visa | guarantee: bounded

--- what really happened at the vendors ---
    fly: seat HELD
    stay: room BOOKED + CHARGED
    visa: FEE TAKEN (non-refundable)
    fly: seat TICKETED (fare charged)      <- the trip is COMPLETE and VALID

>> coordinator died (after ALL 4 calls succeeded)

--- recovery ran ---
    stay: REFUNDED                          <- destroys a valid booking
    fly: cancel called but NO LIVE HOLD -> returns {released:true} anyway

   final real state: seat TICKETED, hotel REFUNDED, visa PAID
```

The traveller now has a flight and a visa to London and **no hotel**, because the recovery
system refunded it. Nobody was notified that this was a destructive action.

And the second line matters independently: `fly.release_seat` is called on an
already-ticketed seat. Look at the real vendor:

```js
// vendors/fly/fly.mjs:63
async run({ ref }) {
  const id = ref?.ref ?? ref;
  if (state.holds.delete(id)) state.inventory += 1;
  return { ref: id, released: true };          // <- ALWAYS reports success
}
```

The hold is gone (ticketing deleted it), so `delete` returns `false`, nothing happens —
**and the vendor returns `{released: true}` anyway.** Recovery counts that as a successful
reversal.

In the two-party case the report is worse. Same setup with just fly + stay:

```
SAGA FULLY SUCCEEDED: fly.reserve, stay.execute, fly.confirm
  -> flight is TICKETED, hotel is CHARGED. Trip is valid.

AFTER RECOVERY: reversals executed: stay.compensate, fly.cancel
  outcome shown to the user: in-doubt
  UI headline: "Nothing stands — every reversible step was reversed"

  REALITY: the seat is still ticketed and paid. The hotel has been refunded.
```

**The system tells the user nothing stands, while a ticket stands and a refund was
issued.** That is precisely the lie the README says the design exists to prevent.

**Root cause:** `recover()` has no model of step *supersession*. It needs to know that
`confirm` on a vendor invalidates the reversibility of that vendor's `reserve`, and that
`compensate` is only appropriate if the saga did not reach a committed terminal state.

**Fix sketch (do this one first):**
1. Write a `PHASE.STARTED` row at saga start recording the planned order and phase count.
2. Write a `settled` row **before** the last confirm as an intent, or add a
   `PHASE.COMMITTING` marker once the point of no return is crossed.
3. In `recover()`, build a per-vendor step map first. If `confirm` for vendor V is `done`
   or probes as `happened`, **remove V's `reserve` from the reversal set** and mark it
   final.
4. If the last planned step is `done`/`happened`, the saga is **committed**, not
   interrupted. Settle it as `COMMITTED` and reverse nothing.

### 1.2 — 🔴 The test suite asserts the bug as the specification

`concord/recover.test.mjs:89` — "recovery is correct at every crash point, and never
double-reverses" — is the test the README cites as "the exhaustive test crashes at every
step boundary... and asserts that whatever really happened was undone exactly once."

Its expectation is computed as:

```js
const undoable = [...w.performed.keys()]
  .filter((k) => /\.(reserve|execute)$/.test(k) && !k.includes('visa'));
const expected = undoable.map((k) => k.includes('fly') ? 'fly.cancel' : 'stay.compensate');
```

That says: *reverse every reserve and execute that happened, regardless of whether it was
subsequently confirmed.* The loop runs `at = 1..4` and the saga has exactly 4 calls, so
`dieAfter: 4` **is** the completed-transaction case from 1.1 — and the test asserts that
refunding the hotel and cancelling the ticketed seat is correct behaviour.

**The test passes because it encodes the wrong specification.** All 34 tests pass; this
one is green for the wrong reason. Any test suite can only be as good as its oracle, and
this oracle is wrong at exactly the point that matters.

### 1.3 — 🔴 "Fully atomic" is not atomic

`ladder.mjs:160`, `describe()`:

> "**Fully atomic.** Every vendor holds a reservation, and **nothing is committed anywhere
> until all of them have agreed.**"

The README's rung table says the same: "reservable — Nothing observable happens until
every participant agrees."

But phase 4 is a **sequential per-vendor loop** (saga.mjs:167):

```js
for (const record of [...held]) {
  for (let attempt = 1; attempt <= confirmRetries; attempt++) { ... confirm ... }
  if (lastError) { /* IN_DOUBT */ }
}
```

With three reservable vendors: confirm A succeeds → confirm B succeeds → **confirm C
fails**. A and C… A and B are now irreversibly ticketed, C is not. That is a partial
commit. It is the classic two-phase-commit non-atomicity, and it is unavoidable without a
coordinator both sides trust — which is the thing Concord's premise says doesn't exist.

The code handles it honestly (it reports IN_DOUBT). The *marketing string* does not. The
UI headline literally reads **"Fully atomic"** for a guarantee that can partially commit.
By the project's own standard this is the lie.

**Fix:** rename `ATOMIC` → something like `all-or-nothing up to confirm`, and change
`describe()` to state the residual risk: "Nothing is committed until every vendor has
agreed; the final confirm fan-out can still partially fail, in which case you are told
exactly what stands."

### 1.4 — 🔴 A transient error on the irreversible step silently strands a real charge

Phase 3 (saga.mjs:158) calls the irreversible `execute`. If that call throws for **any
non-fatal reason** — a network blip, the shim's 1500ms timeout, a dropped postMessage —
control falls to the outer `catch` and `unwind()` runs immediately.

`unwind()` **never probes `concord.status`.** It just compensates and cancels.

So: the consular fee is actually taken at the vendor, the reply is lost, and Concord
refunds the hotel, releases the seat, and reports **"Nothing stands — every reversible
step was reversed."** The $260 non-refundable fee is gone and nothing in the system knows.

You built the exact tool for this — the `concord.status` probe — and then only wired it
into crash recovery, not into in-flight error handling. The README says "Recovery does not
guess... So the coordinator asks." The live path does not ask.

**Fix:** before `unwind()` reverses anything, probe `status` for the step that just failed.
If it happened, treat it as committed rather than failed.

### 1.5 — 🟠 The ladder never checks whether a vendor can be recovered

`classify()` (ladder.mjs:38) looks at `reserve`/`confirm`/`cancel`/`execute`/`compensate`.
It **never looks at `status`.**

`recover.mjs:38` treats a missing `status` as unresolvable-forever — correctly, and the
README makes a point of it:

> "A vendor declaring no status step is reported **unresolved**, never assumed."

But the planner will happily promise **atomic** for a set of vendors where one has no
`status` tool. That vendor is a guaranteed permanent in-doubt on any crash. The guarantee
computed "before anything is contacted" is therefore not the honest guarantee — it omits
the recoverability dimension entirely.

**Fix:** add a fourth caveat, or downgrade the guarantee, when any participant lacks
`status`.

### 1.6 — 🟠 Recovery uses the wrong idempotency key, enabling double compensation

Live unwind (saga.mjs:109) invokes compensate with key:

```
`${sagaId}.${id}.compensate`
```

Crash recovery (recover.mjs:71) invokes the same logical operation with:

```
`${step.idempotencyKey}.undo`     // = `${sagaId}.${id}.execute.undo`
```

**Different keys for the same operation.** The vendor's dedupe map is keyed on
`args.idempotencyKey` (kit/vendor.mjs:103), so a saga that partially unwound and then
crashed will, on recovery, present a key the vendor has never seen and **the compensation
runs a second time.** Double refund.

The README explicitly claims: "asserts that whatever really happened was undone **exactly
once**." The test never exercises unwind-then-crash-then-recover, so it doesn't catch this.

**Fix:** one key derivation function shared by both paths.

### 1.7 — 🟠 Recovery reverses in the wrong order

`recover.mjs:31,47,56`:

```js
const happened = [...saga.completed];        // chronological
...
if (status.happened) happened.push({...});   // probed steps APPENDED at the end
...
for (const step of [...happened].reverse())  // "newest first"
```

Probed (uncertain) steps are appended after all completed steps regardless of when they
actually occurred, then the whole list is reversed. So **the uncertain step is always
reversed first**, even if it was chronologically the earliest. The comment says "undo what
really happened, newest first"; the code does not do that. Where compensation order
matters (it does in any real saga), this unwinds backwards.

**Fix:** merge probed steps back into chronological position using the journal `at`
timestamps, which you already record.

### 1.8 — 🟠 Recovery is not itself crash-safe

`recover()` writes **nothing** before it starts calling vendors. It journals only at the
very end (`journal.settled`, line 82). Kill the tab mid-recovery and the next run redoes
every reversal from scratch — with, per 1.6, keys that may or may not dedupe.

This is the exact sin the design condemns in the saga ("intent is written before the call,
never after"). Recovery gets an exemption it hasn't earned.

### 1.9 — 🟠 Recovery uses the UI's *current* scenario, not the crashed saga's participants

`kernel/concord.mjs:168`:

```js
const fresh = participantsFor(current);      // <- whatever tab is selected NOW
const reports = await recover({ journal, participants: fresh, call: bind(ctx, fresh) });
```

Crash on "Flight + hotel + visa", click over to "Flight only", then click Resolve.
`byId.get('stay')` is `undefined` → `statusTool` is `undefined` → stay is reported "declares
no status step" → **the hotel charge is stranded and blamed on the vendor.**

The journal records `vendor` on every row. Reconstruct participants from the journal, not
from the UI selection.

Related: `PHANTOM` (concord.mjs:32) has `tools: {}`, so if the refused scenario is selected
during recovery, `bind()` throws `permit does not expose ...`.

### 1.10 — 🟠 Only the first interrupted saga is ever shown or resolvable

`showPending()` (concord.mjs:155) does `const s = outstanding[0]`. If two commitments were
interrupted, the second is invisible in the UI forever. `recover()` processes all of them
but `renderReceipt` reports only `reports[0]`, so the user sees a resolution message that
doesn't describe what actually happened.

### 1.11 — 🟡 `confirmRetries = 0` silently reports success on a call never made

```js
for (let attempt = 1; attempt <= confirmRetries; attempt++) { ... }
if (lastError) { /* IN_DOUBT */ }
```

With `confirmRetries <= 0` the loop body never executes, `lastError` stays `null`, and the
record falls through as confirmed. The saga returns `COMMITTED` having never called
`confirm`. Guard the input.

---

# TIER 2 — SECURITY

### 2.1 — 🔴 Stored XSS on every vendor origin, triggered by coordinator-supplied input

The vendors render tool arguments straight into `innerHTML` with **no escaping at all**:

```js
// vendors/fly/fly.mjs:73
`<div class="row"><span>${h.ref} · ${h.route}</span>...`     // route = tool argument

// vendors/visa/visa.mjs:39
`<div class="row"><span>${f.ref} · ${f.applicant}</span>...` // applicant = tool argument

// vendors/stay/stay.mjs:58
`<span>${b.ref} · ${b.nights} nights</span>`                 // nights = tool argument
```

and `paint()` does `el.innerHTML = render(state)`.

There is **no runtime schema validation anywhere in the Concord path.** `kernel/dispatch.mjs`
has a `validate()` function, but `kit/vendor.mjs` bypasses dispatch entirely and calls
`spec.run(args)` with raw arguments. So `nights: "<img src=x onerror=...>"` sails through
despite `type: 'number'`.

The coordinator controls those arguments. **Therefore the coordinator can execute
JavaScript on the vendor's origin.**

### 2.2 — 🔴 …and that XSS reaches an unauthenticated signing oracle

`server.mjs:75` exposes `POST /_concord/sign` on every vendor origin. It signs **any
JSON statement handed to it**, with no authentication, no nonce, and no check that the
statement corresponds to anything the vendor actually did.

`kit/keystore.mjs:64` admits this in a comment:

> "an endpoint that signs whatever it is handed is a signing oracle... that trust boundary
> is the thing a production port has to move."

Chain 2.1 into 2.2 and the receipt's foundational claim collapses:

> "The coordinator... **cannot write one, because it never holds a vendor's key.**"

It doesn't need to hold the key. It passes a payload that XSSes the vendor page, and the
vendor's own page signs whatever the coordinator wants with the vendor's real key. Every
signature verifies.

Cross-origin `fetch` to `/_concord/sign` is blocked only by accident — the server has no
`OPTIONS` handler, so the CORS preflight for `Content-Type: application/json` fails. That's
not a designed boundary.

### 2.3 — 🔴 Three working receipt forgeries. I ran all three.

```
=== ATTACK 1: statements harvested from DIFFERENT sagas, presented as one commitment ===
  receipt claims sagaId: saga_TODAY
  entry sagaIds actually: saga_LAST_MONTH, saga_SOMEONE_ELSE
  outcome claimed: committed (nothing signs the outcome)
  VERIFIER SAYS ok = true

=== ATTACK 2: coordinator substitutes its OWN origin for a vendor name ===
  statement claims vendor: "fly", charged $9,999.99
  signed by: an evil key at coordinator-controlled.example
  VERIFIER SAYS ok = true   findings: [{"vendor":"fly","included":true,"signed":true}]

=== ATTACK 3: silently DROP an inconvenient statement ===
  full receipt    root: 9aab2396dd7ec352  entries: 2  verifies: true
  trimmed receipt root: b29e12b8a6899af0  entries: 1  verifies: true
```

**Attack 1 — no saga binding.** `verifyReceipt` never checks
`entry.statement.sagaId === receipt.sagaId`. A coordinator can stitch signed statements
from unrelated transactions into one receipt. Nothing signs `outcome` either, so the
coordinator freely asserts "committed" over a set of statements from an unwound saga.

**Attack 2 — the origin map is coordinator-written and unauthenticated.** This is the
deep one. The README's whole security argument is:

> "The key is published at `/.well-known/concord.json` **on the vendor's own origin**...
> a key fetched from the vendor over TLS is bound to that vendor by the guarantee the web
> already provides."

True — but `receipt.vendors` maps **vendor name → origin**, and that map is written by the
coordinator (`client.mjs:62`, `receipt.mjs:142`). A verifier has no independent way to know
that `"fly"` should be `fly.example` rather than `evil.example`. TLS proves you're talking
to whatever origin you were pointed at; it does not prove that origin is the right party.
**The anchor is not anchored.** The verifier output "signed by the party named" is decided
by a map the accused party wrote.

*Fix:* the statement itself must carry the vendor's own origin (`origin: location.origin`
is already in `concord.protocol` — put it inside the signed statement), and the verifier
must resolve keys from `entry.statement.origin`, never from `receipt.vendors`.

**Attack 3 — no cardinality commitment.** Nothing commits to how many statements a saga
produced, so the coordinator can drop the entry it doesn't like and the trimmed receipt
verifies cleanly. *Fix:* have each vendor sign the count/step-list from the plan, or
publish the expected leaf count as part of a signed plan digest.

**Also missing from the signed statement:** any timestamp, expiry, or nonce beyond the
idempotency key — which is itself derived from `Math.random()` (see 2.5). No replay
protection.

### 2.4 — 🔴 The shim resolves tool results without checking the sender

`shim/webmcp.mjs:107`:

```js
if (msg.kind === 'tools' || msg.kind === 'result') {
  const resolve = this.#pending.get(msg.id);
  if (resolve) { this.#pending.delete(msg.id); resolve({ msg, source: e.source, origin: e.origin }); }
  return;
}
```

No check that `e.origin` matches the origin the request was sent to. And request IDs are
fully predictable:

```js
const id = `${ORIGIN}#${this.#seq++}`;      // "http://localhost:5173#0", "#1", "#2"...
```

**Any frame in the tab's frame tree can forge a tool result** — including a fabricated
signed attestation — by guessing the next sequence number. Every `postMessage` also uses
`targetOrigin: '*'` (lines 70, 83, 100, 147, 180), broadcasting tool names and arguments to
every frame.

The `exec` path *does* check visibility correctly (line 91) — that part is right. It's the
reply path that's open.

### 2.5 — 🟠 Idempotency keys are `Math.random()`-derived and guessable

```js
sagaId = `saga_${Math.random().toString(36).slice(2, 10)}`     // saga.mjs:45
const key = (id, step) => `${sagaId}.${id}.${step}`;           // saga.mjs:59
```

~41 bits of non-cryptographic randomness, and the key structure is fully public
(`saga_XXXX.fly.reserve`). Anything that can guess a sagaId can replay or pre-poison a
vendor's dedupe map. For a protocol whose entire safety story rests on idempotency keys,
this should be `crypto.randomUUID()`.

The vendor `ref` generators have the same issue (`NW${Math.random()...}` — 5 base-36 chars,
~26 bits; collisions are plausible within a session).

### 2.6 — 🟠 The vendor's break-switch `postMessage` listener has no origin check

```js
// kit/vendor.mjs:138
addEventListener('message', (e) => {
  const order = e.data?.__concord_break__;
  if (!order || !steps[order.step]) return;
  order.on ? failing.add(order.step) : failing.delete(order.step);
  ...
});
```

No `e.origin` validation. Any frame in the tree can disable any vendor's ability to
`confirm` or `compensate` — i.e. **force the system into IN DOUBT and strand money.** In a
project whose thesis is mutually-distrusting origins, this is an unguarded control channel.

### 2.7 — 🟠 Failure injection cannot simulate the failure that matters

The break switch is checked *after* the replay check but *before* `spec.run` (vendor.mjs:108).
So it can only simulate **"vendor refuses."** It can never simulate **"vendor acted, then
the reply was lost"** — which is the entire reason `concord.status` and the write-ahead
journal exist.

The README says: "The exhaustive test crashes at every step boundary, **both before and
after the vendor acted**." That's true in the *unit* tests (`world({dieAfter})` in Node),
but the **browser demo cannot do it** — and the browser demo is what a judge will interact
with. The most important scenario in the project is unreachable from the UI.

### 2.8 — 🟡 `esc()` is incomplete

Both `kernel/concord.mjs:21` and `kernel/harness.mjs:8`:

```js
const esc = (s) => String(s).replace(/[<&]/g, (c) => ({ '<': '&lt;', '&': '&amp;' }[c]));
```

Escapes `<` and `&` only — no `>`, `"`, or `'`. Sufficient for element-content context,
**unsafe the moment any of it moves into an attribute.** `concord.mjs:104` already
interpolates into `data-key="..."` (safe today only because the value is developer-controlled).
And `kit/vendor.mjs:152` is worse — it *strips* `[<&]` rather than escaping, silently
mangling legitimate content.

### 2.9 — 🟡 No key rotation, expiry, or revocation

`wellKnown()` publishes one key with `status: 'active'`. There is no `notBefore`/`notAfter`,
no revocation list, no rotation procedure. The README claims "the receipt still verifies in
a year" — but a key compromised in month six retroactively forges the entire history, with
no mechanism to say so. `verifyReceipt` also has no freshness requirement.

### 2.10 — 🟡 `canonical()` is a bespoke non-standard serialisation

```js
return `{${Object.keys(value).sort().map(...)}}`;
```

- Sorts by **UTF-16 code unit**, not code point. RFC 8785 (JCS) requires code-point order.
  Keys containing surrogate pairs sort differently.
- `{a: undefined}` canonicalises to `{"a":null}`, where `JSON.stringify` gives `{}`.
- No `-0`, `NaN`, or large-integer handling.

Both signer and verifier use the same function so it's internally consistent — but a
third-party verifier written against JCS **will not verify these receipts**, which
undermines the interop story for a protocol whose entire pitch is "no partnership required."

---

# TIER 3 — WebMCP / PLATFORM

### 3.1 — 🔴 `executeTool` is called with an object; the spec requires a JSON string

Chrome's imperative-API docs, verbatim:

> "call `document.modelContext.executeTool()` with input arguments **as a valid JSON
> string**."
>
> ```js
> const result = await document.modelContext.executeTool(tool, '{"text": "Buy milk"}');
> ```

Concord, `concord/client.mjs:50` and `:20`:

```js
const raw = await ctx.executeTool(tool, { ...args, idempotencyKey, sagaId });   // OBJECT
const protocol = JSON.parse(await ctx.executeTool(declaration, {}));            // OBJECT
```

The shim accepts objects (webmcp.mjs:163), so everything is green locally. **On native
WebMCP every vendor call fails** — either a TypeError or `"[object Object]"` reaching the
tool as its argument string.

This is a one-line fix (`JSON.stringify(...)`) but it is currently the difference between
"works for judges" and "blank page for judges."

**Related return-shape risk:** the shim always returns `JSON.stringify(value)` and the
client always `JSON.parse`s it. Chrome's docs show `executeTool` returning the tool's raw
return value (`'Added to-do: Buy milk'` — a plain string). If native returns a bare string,
`JSON.parse` throws. Untested either way.

### 3.2 — 🔴 "A browser upgrade, not a code change" is an untested claim, and 3.1 falsifies it

README:

> "`shim/adapter.mjs` prefers native on both spellings and falls back only when neither
> exists, so **moving to a real Chrome 149+ is a browser upgrade, not a code change.**"

The repo was developed against **Chrome 134** (README, "Requirements"), which predates
WebMCP entirely. So the native path has **never been executed.** Given 3.1, it demonstrably
does not work.

This is doubly serious because of what the adapter does when native *is* present:

```js
// shim/adapter.mjs:21
if (native) return { ctx: native, provider: 'native', surface, policy };
```

It returns the native context and then the rest of the code calls
`ctx.registerTool(tool, { exposedTo: [...] })`. `exposedTo` and `fromOrigins` **are** real
spec features (I verified this — good instinct), so the architecture is legitimate. But
whether Chrome's implementation matches the shim's frame-tree-walk semantics is entirely
unverified.

**Judges will open this in ChatGPT's in-app browser, which "supports WebMCP out of the box"
— i.e. the native path.** `document.modelContext` will exist, the shim will not install, and
you get the untested code path on the one run that counts.

**This is the highest-leverage thing you can fix in the next 48 hours:** get Chrome 149+
with `chrome://flags/#enable-webmcp-testing`, run the demo natively once, and fix what
breaks.

### 3.3 — 🟠 The permissions-policy self-report is broken

```js
// shim/adapter.mjs:16-19
let policy = 'unknown';
try {
  policy = document.permissionsPolicy?.allowsFeature?.('tools') ? 'granted' : 'absent';
} catch { policy = 'unsupported' }
```

The optional chaining swallows the missing-API case: if `document.permissionsPolicy` is
undefined, the expression is `undefined` → falsy → `'absent'`. The `catch` never fires and
`'unsupported'` is unreachable. So the probe reports **`tools-policy=absent`** when it
actually means *"I could not determine this."*

The README makes a virtue of this reporting ("The probe reports `tools-policy=absent`
rather than implying otherwise"). It's reporting the wrong thing for the wrong reason.
Also: the standard API is `document.featurePolicy` in most Chrome versions.

### 3.4 — 🟠 Hardcoded timeouts too tight for real networks

| Location | Timeout | Problem |
|---|---|---|
| `webmcp.mjs:145` | **250 ms** for `getTools` per frame | Across 3+ cross-origin iframes on a cold load this races |
| `webmcp.mjs:177` | **1500 ms** for `executeTool` | Any vendor slower than 1.5s fails the whole saga |
| `harness.mjs:50` | 4000 ms `awaitTools` deadline | Then **resolves anyway** with whatever it has — a silent partial discovery |
| `concord.mjs:311` | `setTimeout(..., 900)` after iframe reload | Pure race; slow machine → stale plan |

`awaitTools` resolving on timeout rather than rejecting is the nastiest: `discover()` then
returns fewer participants, `plan()` computes a guarantee over an incomplete set, and the
UI confidently displays a promise about vendors it never reached.

### 3.5 — 🟠 No call timeout or cancellation in the saga

`runSaga` never passes an `AbortSignal` and has no per-call deadline. A hung vendor hangs
the entire commitment indefinitely while holding real reservations. WebMCP's `execute`
receives a `signal` specifically for this and it's unused on the calling side.

### 3.6 — 🟠 Reservation TTLs are decorative

`fly` declares `ttlSeconds: 900`. The saga reads it — once — purely to display it:

```js
emit('reserved', { id, ref, ttlSeconds: byId.get(id).protocol.steps.reserve.ttlSeconds ?? null });
```

Nothing enforces it. Nothing warns as it approaches. Nothing aborts if elapsed time exceeds
the shortest TTL before confirm. The vendor doesn't expire holds either (no timer in
`fly.mjs`) — so the "fifteen-minute hold" described in the tool description and the README
is fiction on both sides.

### 3.7 — 🟡 Confirm retry budget is ~360ms total

`confirmRetries = 3`, `retryDelayMs * attempt` → sleeps of 120ms and 240ms (260/520 in the
UI). The README presents retry-under-the-same-idempotency-key as a serious durability
measure. Under a second of retrying is not meaningful resilience against the transient
failures it's meant to survive. No jitter, no exponential backoff, no distinction between
retryable and terminal errors.

---

# TIER 4 — ROBUSTNESS & DATA

### 4.1 — 🔴 The journal is O(n²) and will eventually break the saga

```js
// journal.mjs:28
async append(row) { localStorage.setItem(this.key, JSON.stringify([...this.#load(), row])); }
```

Every append parses and re-serialises the **entire history**. Three consequences:

1. **O(n²) growth.** Each commit adds ~8–10 rows. After a few hundred commits this is
   visibly slow on the UI thread (localStorage is synchronous).
2. **Never pruned.** `clear()` exists and is never called. Settled sagas stay forever.
3. **Quota death.** At ~5MB `setItem` throws `QuotaExceededError`. That throw propagates
   out of `journal.intent()` inside `invoke()` — **before the vendor call** — aborting the
   saga. Worse, it's uncaught, so it surfaces as an unhandled rejection with no UI.

The durability layer fails precisely when it has the most to protect.

### 4.2 — 🟠 `LocalStore.append` is a non-atomic read-modify-write

Two tabs of `concord.html` open simultaneously → lost journal rows → recovery cannot see
steps that happened. The whole premise is "a saga held in memory is a demo"; a racy
read-modify-write on localStorage is not much better. Use `IndexedDB` with an append-only
object store, or a `BroadcastChannel` lock.

### 4.3 — 🟠 Vendor state and idempotency memory die on reload

```js
// kit/vendor.mjs:21
const seen = new Map();     // idempotency key -> the answer we already gave
```

In-memory, per page load. **Reload a vendor iframe and `concord.status` starts answering
`happened: false` for steps that genuinely happened.** Recovery then believes nothing
occurred and — per the README's own reasoning — "assuming it did not happen strands the
charge."

The `reset` button (`concord.mjs:308`) reloads all three iframes, so a user one click away
can silently destroy the recovery ground truth. The README's "receipts outlive the tab" is
true of the *keys* (which are server-side, well done) but false of the *transaction state*.

### 4.4 — 🟠 No error boundary anywhere in the coordinator

`renderPlan()` calls `plan()`, which throws `PlanError` for a participant declaring no
usable protocol (ladder.mjs:51). It's not wrapped. `concord.mjs` is a top-level-await
module — **any throw during init leaves a completely blank page** with no message. Same for
`discover()` if a vendor returns malformed JSON.

Given this is what judges load first, a single failing vendor renders the entire submission
as a black screen.

### 4.5 — 🟡 `classify()` throws instead of refusing

The README frames **refused** as one of four honest outcomes. But a participant with, say,
`reserve` + `cancel` but no `confirm` doesn't get refused — it throws a `PlanError` out of
`plan()`. Two different failure modes for what is conceptually the same answer ("no honest
promise available"), and only one of them is handled.

### 4.6 — 🟡 The tamper demo produces the generic error the README says it avoids

README:

> "Give a statement someone else's signature and it reads `fly reserve — in tree yes,
> signed NO`, with the other three still valid: the receipt **names the bad statement
> instead of collapsing into "invalid"**."

But `verifyReceipt` early-returns on root mismatch (receipt.mjs:156) with a single generic
finding and **no per-entry detail**. And the `Edit one entry and re-verify` button
(concord.mjs:288) edits `statement.result.minor` — which changes the leaf — which triggers
exactly that generic path:

> `the entries do not hash to the stated root`

The per-party accusation the README advertises only happens in the borrowed-signature case,
which **the demo button never triggers.** So the one interactive proof you invite judges to
run demonstrates the opposite of the claim in the prose.

*Fix:* make the button do a signature swap, or run both checks and report both.

### 4.7 — 🟡 `originResolver` caches rejected promises forever

```js
if (!cache.has(origin)) cache.set(origin, fetchKeys(origin));
```

Caches the **promise**, including a rejection. One transient fetch failure poisons that
origin for the lifetime of the verifier. No timeout, no retry, no size limit, no
content-type check on the fetched key document.

### 4.8 — 🟡 325 lines of orphaned, unreachable code

`synth/synthesize.mjs` (224 lines) and `tools/synth-probe.mjs` (101 lines) have **zero
references** in `package.json` and are not mentioned in the README's Layout. That's ~6% of
the repo that no script can reach and no reader can contextualise. The commit that added
them is titled "Synthesis experiment: can unprepared sites yield composable tools?" —
interesting work, but as shipped it's dead weight that makes the repo look unfinished.

### 4.9 — 🟡 The "kill the coordinator" demo doesn't kill anything

`killAfter` (concord.mjs:142) throws a flagged error inside a still-running page; the click
handler catches it and immediately calls `showPending()`. Nothing is actually killed. It's
a faithful *simulation* of the journal state a crash produces (the intent is genuinely left
standing alone), but the README's framing — "Press **Commit, then kill the coordinator**...
**Reload**, and the page says an interrupted commitment was found" — oversells it, and a
judge who checks will notice the page never reloaded.

Also: it only ever tests `crashAfter = 2`. One crash position, hardcoded.

---

# TIER 5 — FRONTEND QUALITY & ACCESSIBILITY

### 5.1 — 🟠 The flagship page has no semantic structure at all

I counted occurrences of `<h1>`, `<h2>`, `<main>`, `<nav>`, `aria-live`, and `role=` in
`kernel/concord.html`:

```
0
```

Zero. It is entirely `<div>` and `<span>`. Consequences:

- **No heading hierarchy** — screen readers get a flat wall of text.
- **No landmarks** — no way to skip to content.
- **No `aria-live` on `#run`, `#outcome`, or `#pending`** — the execution log streams
  updates that are completely invisible to assistive tech. This is the *entire demo*.
- No `<html>` or `lang="en"` (the file starts at `<!doctype html>` then `<meta charset>`).

The vendor pages do slightly better (`<h1>`, `<h2>` present) but also lack `<html lang>`.

For a criterion reading "**a complete, coherent product experience — not just a technical
proof of concept**," this is the kind of thing that separates a proof of concept from a
product.

### 5.2 — 🟡 External font dependency with no fallback strategy

`concord.html:4-6` preconnects and loads IBM Plex from Google Fonts. Offline, on a
restricted network, or in a sandboxed judging environment, you get FOUT into the system
monospace stack. Minor, but self-host is one file.

### 5.3 — 🟡 No loading, empty, or error states

There's a `#sub` that says "reading declarations…" and then "declarations read", but:
- No spinner or skeleton during the 4s `awaitTools` window
- No state for "a vendor failed to load"
- No state for "discovery returned 2 of 3"
- No visible error surface at all (see 4.4)

The README's own "Next" section lists these as unfinished Phase 05 work: "empty states,
first run, mid-flight cancel, refresh." Correct self-assessment — but it means the product
experience criterion is being scored against a knowingly incomplete surface.

### 5.4 — 🟡 No mid-flight cancel

Once **Commit** is pressed there is no way for a human to stop it. For a system whose
premise is "cancellation as a first-class primitive... under the user's authority," the
user has no cancel button. Also listed as Phase 05 future work.

### 5.5 — 🟡 Fixed-height iframes at 322px

`iframe { height: 322px; }` — the vendor pages have variable content (state rows + feed
entries grow as the saga runs). Long runs scroll inside a small box; on mobile the whole
three-iframe column is unusable. The `@media (max-width:940px)` rule stacks the columns but
doesn't address iframe height.

---

# TIER 6 — DOCUMENTATION ACCURACY

Consolidated list of README statements that don't match the code:

| README says | Reality |
|---|---|
| `npm run concord # the coordinator` | It's a headless screenshot tool (`tools/shot.mjs`) |
| "server.mjs — **two origins**" | Serves seven |
| Layout section | Documents Ring 0 only; omits `concord/`, `kit/`, `vendors/`, `synth/` — i.e. the actual submission |
| "**every vendor** exposes `concord.status`" | True only because `kit/vendor.mjs:84` injects it; none of the three vendor files declares it. Worth stating, since it's the kit that guarantees this |
| "moving to a real Chrome 149+ is a browser upgrade, **not a code change**" | Falsified by the `executeTool` object-vs-JSON-string mismatch (3.1) |
| "undone **exactly once**" | Key mismatch between unwind and recovery paths allows double compensation (1.6) |
| "atomic — every vendor holds a reservation" / "**Fully atomic**" | Confirm is a non-atomic per-vendor fan-out (1.3) |
| "the receipt **names the bad statement** instead of collapsing into 'invalid'" | The demo's own tamper button produces the generic collapse (4.6) |
| "It cannot write one, because it never holds a vendor's key" | XSS→signing-oracle chain (2.1+2.2); origin-map substitution (2.3 Attack 2) |
| "Recovery does not guess... the coordinator asks" | Only on restart. The live `unwind()` path never asks (1.4) |
| "**A dead process writes nothing**" | Accurate and well implemented — credit where due |
| "34 tests / 18 probes" | **Verified accurate.** Both numbers are exactly right |

Missing from the repo entirely: `CONTRIBUTING.md`, `SECURITY.md`, `.env.example`, any CI,
any architecture diagram, any screenshot or GIF (for a visual project with no live URL,
this is a real omission), and any instructions for running against native WebMCP or in
ChatGPT's browser.

---

# TIER 7 — HOW THIS SCORES AGAINST THE FOUR CRITERIA

The rules weight these **equally**.

### WebMCP Leverage — *weak-to-moderate*
Uses `registerTool`, `getTools({fromOrigins})`, `executeTool`, `exposedTo`, `toolchange`,
`allow="tools"`, `Origin-Agent-Cluster`, and `annotations.readOnlyHint`. That is genuinely
broad — broader than most submissions will be. **But:** most of the run time is spent
inside a hand-written shim rather than the real API; the native path is untested and
provably broken (3.1); and WebMCP is used as a **cross-origin RPC transport between two
web pages**, not as the agent-facing surface it is designed to be. A judge who is a WebMCP
spec author (Alex Nahas created MCP-B; Sarah Drasner is Chrome; Justin Rushing is OpenAI's
browser platform lead) will notice this framing immediately.

### Execution — *currently failing*
No live URL, no video, no deployment path, blank-page failure modes, zero accessibility
semantics, and a README that closes by listing what's unfinished. The 34 passing unit tests
and 18 browser probes are a genuine strength and unusual for a hackathon — lead with them.

### Potential Impact — *strong thesis, undermined by the bugs*
The 15–30% marketplace-margin argument is the best part of the submission and it is a real
problem with a real audience. But "Potential Impact" is scored on *"does the solution
actually address that problem **based on what's demonstrated**"* — and what's demonstrated
currently includes a recovery routine that refunds valid bookings and a receipt scheme with
three working forgeries.

### Creativity & Ambition — *very strong, your best category*
Atomic cross-vendor commitments with no intermediary is a genuinely novel framing for
WebMCP. Nobody else will submit a commitment ladder or a selective-disclosure Merkle
receipt. The `refused` outcome — a system that declines to promise — is a legitimately
original idea. **This is where you're winning; protect it by making the rest credible.**

---

# THE 48-HOUR TRIAGE

Ordered by (impact × certainty) ÷ effort. Deadline **Sep 3, 1:00pm PDT**.

## Must do — without these you cannot be scored

1. **Fix `executeTool` to send a JSON string.** One line in `client.mjs` ×2. Then test on
   real Chrome 149+ with `chrome://flags/#enable-webmcp-testing`. **(§3.1)**
2. **Deploy four origins over HTTPS.** Netlify or Render. Replace the 36 hardcoded
   localhosts with a single config module resolved from `location.origin` or an env-injected
   constant. Verify `Origin-Agent-Cluster: ?1` and `Permissions-Policy: tools=(...)` survive
   the host. **(§0.1)**
3. **Fix the keystore for deployment** — commit fixed test keys or read from env. Otherwise
   receipts fail immediately on the live URL. **(§0.2)**
4. **Record the video.** ~2:45. Suggested beat sheet:
   *the 15–30% margin problem → the ladder computing a guarantee before contact → break the
   consular fee live and watch the hotel refund and seat release on the vendors' own pages →
   the refusal case → verify a receipt in the terminal.* Say "WebMCP" and name the specific
   APIs, out loud, at least twice. **(§0.3)**
5. **Open the live URL in ChatGPT's in-app browser once, end to end.** That is the judging
   environment. Whatever breaks there is what matters.

## Should do — these are the credibility fixes

6. **Fix the recovery-destroys-committed-sagas bug (§1.1).** If you fix one logic bug, this
   one. Add a phase/committed marker and make `recover()` skip vendors whose `confirm`
   succeeded. Then fix the test that currently asserts the wrong thing (§1.2).
7. **Probe `status` before unwinding on the irreversible step (§1.4).** You already have the
   tool; wire it into `unwind()`.
8. **Escape output in the three vendor `render()` functions (§2.1).** Three small edits,
   closes the XSS→signing-oracle chain.
9. **Bind statements to the saga, and resolve keys from the signed statement's own origin,
   not `receipt.vendors` (§2.3).** Kills Attacks 1 and 2. Attack 3 needs a cardinality
   commitment — mention it as known future work if you can't get to it.
10. **Rename "Fully atomic" (§1.3).** Purely a string change, and it's the difference
    between honest and not by your own stated standard.
11. **Add an error boundary around `renderPlan`/`discover` (§4.4).** A blank page is the
    worst possible judge experience.
12. **Add `aria-live` to `#run` and `#outcome`, plus `<h1>`/`<main>` and `<html lang="en">`
    (§5.1).** Fifteen minutes, directly serves the Execution criterion.

## Nice to have

13. Fix `npm run concord` and the README Layout section (§0.7, §6).
14. Delete or document `synth/` (§4.8).
15. Unify the compensation idempotency key (§1.6).
16. `crypto.randomUUID()` for sagaIds (§2.5).
17. Origin check on the break-switch listener (§2.6).
18. Add a screenshot or GIF to the README.

## The strategic call you have to make

**Add a thin agent layer, or reframe the submission.**

Option A (higher ceiling, ~4–6 hours): put a chat box on `concord.html`. Let a model call
`getTools()`, read the `concord.protocol` declarations, and choose which vendors to
compose from a natural-language request like *"book me London for three nights, and don't
commit to anything you can't take back."* Let the ladder's refusal be something the **agent
reports to the user**. That single change moves you from "protocol using WebMCP as
transport" to "agent-native app where the agent is prevented from making promises it can't
keep" — which is directly on-theme and makes the refusal feature far more compelling.

Option B (cheaper, ~1 hour): keep the architecture and reframe the text description and
video around *"the safety layer an agent needs before it is allowed to spend your money
across sites."* Position Concord as infrastructure for agents rather than as an agent.
Weaker, but honest and much faster.

Do **not** submit with no agent story at all. Stage One is pass/fail on whether the project
"reasonably fits the theme," and the theme is humans and agents together.

---

## Closing note

I want to be clear that the harshness above is calibrated to what you asked for, not to
what I think of the work. The commitment ladder is a genuinely good idea. Separating the
leaf hash from the signature so the receipt can distinguish *"this was altered"* from
*"this vendor never said that"* is a subtle and correct piece of design that most people
would get wrong. Promoting odd nodes instead of duplicating them is a real Merkle
correctness detail. Writing intent before the call rather than outcomes after it is the
right instinct and it is implemented well. Refusing to invent a `compensate` for the
consular fee is exactly the kind of restraint the README claims for itself.

The gap is not between good design and bad design. It is between a **design** and a
**system** — which is the distinction the README itself opens with. Right now the prose is
describing the system you intend, and the code is the design. Close that gap on the four or
five things above and this is a strong submission.

Two days. Deploy first.