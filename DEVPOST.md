# Devpost submission — copy and paste

Every field on the form, in the order the form asks for them. Fields only you can
answer are marked **[YOU]**.

Judging is four criteria of **equal weight** — WebMCP Leverage, Execution,
Potential Impact, Creativity & Ambition — and ties break by comparing them in
that order, so WebMCP Leverage is the first tiebreaker. The story below is
arranged to answer all four in that order, with the leverage section first and
longest.

---

## 1. Project name

*(60 characters max — this is 42)*

```
Concord — an agent that cannot overpromise
```

---

## 2. Elevator pitch

*(200 characters max — this is 193)*

```
WebMCP tells an agent what a site can do. Nothing tells it what a site can take back. Concord is that missing layer: it computes what it can honestly promise across sites before contacting any.
```

---

## 3. About the project

*(Paste everything in the box below, as Markdown.)*

---

## Inspiration

An agent books your flight on one site and your hotel on another. Halfway
through, the hotel fails.

Ask what happens next and no part of the web can answer. `inputSchema` describes
a tool's **shape**. `readOnlyHint` describes whether it has an **effect**.
Nothing anywhere describes whether that effect can be **reversed** — which is the
one fact an agent needs to plan across sites rather than to act and hope.

So today that gap is filled by a marketplace: an intermediary both businesses
have a contract with, which is why one sits between almost every pair of
businesses an agent might transact with, taking **15–30%** to stand there. The
tax is not for the booking. It is for the guarantee.

The failure mode of agentic commerce is not the booking going wrong. It is the
agent telling you it went fine.

## What it does

Concord is a **convention over WebMCP** by which any site declares its
*commitment surface* — one of three rungs:

| Rung | Meaning | Example |
|---|---|---|
| **reservable** | hold it, release it, nothing happened | an airline seat |
| **compensable** | undoable, but it leaves a mark | a hotel charge and refund |
| **irreversible** | it cannot be taken back | a government fee |

…and an **in-browser coordinator** that computes the strongest honest guarantee
across several such sites **before contacting any of them** — then refuses when
the honest answer is that atomicity is not available at any price.

Three things to try on the live URL, in ninety seconds:

1. **Ask for a flight, a hotel and the visa fee.** The agent reads back what it
   can promise, which step is the point of no return, and which charge becomes
   briefly real before being reversed. *Only then* does a **Go ahead** button
   exist.
2. **Ask for a flight, the visa fee and the entry permit** — two things nobody
   can take back. It says it cannot do that as one commitment, and that nothing
   has been contacted. There is no button on that answer.
3. **Kill the coordinator mid-commitment.** Reload. It asks every vendor what
   actually happened and puts back what can be put back.

## Why WebMCP, specifically

This needs exactly the thing WebMCP uniquely provides and nothing else does:
**two mutually distrusting origins' authenticated, typed capabilities present in
one execution context, under the user's authority, with consent enforced on both
sides by the browser.**

That is not scraping and it is not an API partnership. A participant grants with
`registerTool`'s `exposedTo`. The embedder grants with `allow="tools"`. The
coordinator must ask by name with `getTools({ fromOrigins })`. **Three separate
grants, none forgeable by any party, and none requiring the participants to have
heard of each other.** No server anywhere is in the commitment path.

## How WebMCP is implemented

**The permission model is `registerTool` itself.** This is the idea the whole
project rests on:

> `concord_commit` does not exist until a person accepts the exact guarantee they
> were shown. Not disabled. **Not registered.**

Four read-only tools at boot. `concord_explain_guarantee` appears once something
is proposed. Explaining is *not* consent, so the surface does not change when the
agent reads the guarantee out. A human clicks **Accept** on the page —
`registerTool` puts `concord_commit` on the surface. The commitment begins — an
`AbortController` takes it away again, so a second call arriving mid-flight finds
nothing to call. `toolchange` fires on every one of those transitions, and you
can watch it in the tool inspector.

There is no tool that grants that permission, and there will not be one. An agent
has every door; none of them opens this one.

The rest of the surface actually used:

- **`exposedTo`** — each participant exposes its tools only to the coordinator's
  origin, so cross-origin consent is explicit on the participant's side.
- **`allow="tools"` + `Permissions-Policy: tools=(self "…")`** — the embedder's
  half of the same consent, verified on every deployed origin.
- **`Origin-Agent-Cluster: ?1`** — required for cross-document tool access;
  without it `getTools()` returns empty **with no error**.
- **`getTools({ fromOrigins })`** — discovery, opt-in on both sides, asked one
  origin at a time.
- **`executeTool(tool, jsonString)`** — arguments as a JSON string, per Chrome's
  imperative API.
- **`annotations.readOnlyHint`** — used honestly: `true` on the two tools that
  perform nothing, and on nothing that acts.
- **`AbortSignal`** — a deadline on every call, enforced by the coordinator too,
  which does not assume a participant honours cancellation.
- **`modelContext.requestUserInteraction`** — feature-detected. Chrome 151 does
  not implement it, so we measure that and use it wherever it exists: a **second
  door onto the same accept, deliberately not a lock.** A test hands it a host
  that approves every request and requires the surface to stay exactly as it was.
  If asking for attention could produce consent, the central claim would be false.

**And it fills a gap in the standard rather than decorating it.** SPEC §19
proposes the missing annotation upstream:

```js
annotations: {
  readOnlyHint: false,
  commitment: 'reservable' | 'compensable' | 'irreversible',
  reverses: 'release_seat',
  ttlSeconds: 900,
}
```

## The receipt

Every commitment produces an RFC 6962 Merkle receipt in which **every statement
is signed by the counterparty that made it**, with per-vendor ECDSA P-256 keys
resolved from each vendor's own origin over TLS — never from a map the
coordinator writes.

The outcome is **derived from the statements, never read off the receipt**,
because that field is the one thing no vendor signs. Check one on an origin we do
not run, or with `npx concord-verify receipt.json`, and nothing of ours executes.

## How we built it, and what broke

Zero dependencies, on purpose. Node's own test runner, a ~100-line property-testing
kit, and Chrome.

**An audit found the receipt was forgeable.** Seven of fourteen forgeries verified
clean: a coordinator could delete a charge, relabel the outcome "Committed", and
the receipt passed, because `verifyReceipt` gated its strictness on a string
nobody signed. Fixed by deriving the outcome from the entries and by *provable
silence* — a vendor that did nothing signs that it did nothing, so an absence is
distinguishable from a deletion. **You can fire all fourteen at our own verifier
from the live site.**

**Running on the real API found two defects a polyfill can never surface.** The
coordinator was not delegating `tools` to the origins it embeds, so every
participant registered and none was discoverable. And Chrome returns `inputSchema`
as a JSON *string* where the polyfill returns an object. Both worked flawlessly
under the shim — which is the argument for never trusting one.

**`getTools({ fromOrigins })` rejects for the whole call when any one origin is
unreachable.** One dead site produced "0 of 6 answered" and a failure screen with
five participants healthy. Discovery now asks one origin at a time.

## What we learned

**That a sampled mutation score is not a score.** We reported 92%. It came from
60 mutants taken every-Nth from a list sorted by file and by operator — a
stratified sample of a sorted population. Running all 116 gave **87%**. Closing
what that exposed took it to **97% (112/116)**, and the four survivors are
documented as equivalent with the reasoning attached, not hidden.

**That a property test which cannot fail passes loudest.** Our first
reference-model test registered the commit tool in **1%** of the states it
checked, and its unwind-ordering property was vacuous in **95%** of runs because
the fixture had one participant of each rung — so reversing and not reversing
produced identical output. Mutation testing found it. Every property now asserts
how much of the interesting space it reached and fails rather than going green
faster.

**That the measuring instrument needs measuring too.** Our mutation runner's
timeout killed the `npm` wrapper but not the test process beneath it; two orphans
took throughput from ten mutants a minute to ten every three — and a loaded
machine turns survivors into false kills, silently inflating the score.

## Challenges

**Refusing well is harder than committing.** Anyone can run a saga. The hard part
is computing, from declarations alone and before contact, that no honest promise
exists — and then having no button on that answer.

**Proving a negative in a browser.** "The commit tool does not exist yet" is only
worth something if you can watch it not exist. So the claim is checked through the
same `getTools()` an agent calls, state by state, against the live deployment.

**Not overclaiming about our own proof.** We ship a formal model — 855 reachable
states, 9 safety invariants, breadth-first so a violation reports the shortest
trace. `spec/Concord.tla` is *generated* from the same declaration the checker
executes, so it cannot drift. But TLC has not been run against it, and the README
says so in those words rather than letting a `.tla` file imply a proof nobody ran.

## What it can't do — said before you ask

- **A vendor can lie about being compensable.** One does, on purpose, on the live
  URL. Concord cannot prevent it; it makes it *attributable*, because the
  vendor's own signature is on the statement it later declines to reverse.
- **Confirm fan-out is not atomic.** Two vendors can be ticketed and a third
  fail. Documented as an open question with the reason no in-tab protocol fixes it.
- **You still have an intermediary.** Yes — but it is yours. Disposable,
  margin-free, and unable to misreport what happened.

## Evidence, all regenerated by one command

| | |
|---|---|
| assertions, no browser | **163** |
| protocol states model-checked | **855**, against 9 safety invariants |
| ladder configurations, exhaustive | **4,164** |
| mutation score | **97%** over every one of 116 mutants — not a sample |
| forged receipts rejected | **14**, fireable live |
| receipts a malicious coordinator can build, all judged | **180** |
| browser suites against real origins | **7** |
| independent HTTPS deployments | **8** |
| backends in the commitment path | **0** |

`npm run check` runs all of it, and every number is committed under `evidence/`
so one that stops being true stops being printed.

## What's next

Making it a convention rather than an entry. A **conformance suite** that judges
any origin against the spec — including yours, in a text box. A **sandbox** where
ten lines registers a participant the coordinator has never heard of. A drop-in
`<concord-receipt>` element that verifies in the customer's own browser. A GitHub
Action that fails a build when a receipt stops verifying. And the annotation,
upstream, where it belongs.

Six vendors we deployed is a demonstration. Vendors we did not build is a standard.

---

## 4. Built with

*(Devpost allows 25 tags — these are 25, comma-separated for pasting.)*

```
webmcp, javascript, chrome, web-crypto-api, ecdsa, merkle-tree, sha-256, rfc-6962, rfc-8785, saga-pattern, node.js, es-modules, web-components, html5, css3, json-schema, permissions-policy, vercel, npm, github-actions, model-checking, tla-plus, property-based-testing, mutation-testing, zero-dependencies
```

---

## 5. "Try it out" links

Add in this order — the first is the one a judge should click.

```
https://concord-coordinator.vercel.app/judge.html
https://concord-coordinator.vercel.app
https://github.com/iamdflame/concord
https://concord-coordinator.vercel.app/attack.html
https://concord-receipts.vercel.app
https://concord-sandbox.vercel.app
https://www.npmjs.com/package/concord-verify
```

---

## 6. Video demo link

```
https://youtu.be/S3rHWHG-tqo
```

**[YOU] Confirm it is set to Public**, not Unlisted. The rules require public,
and an unlisted video can disqualify. Open it in a private window to check.

---

## 7. Thumbnail and image gallery

**Thumbnail** (3:2, ≤5 MB): `demo/devpost-thumb.png` — generated for this, at
1200×800.

**Gallery**, in this order. The first three carry the whole argument:

| File | Why it earns a slot |
|---|---|
| `demo/cards/02-surface.png` | the tool surface changing state by state — the thesis |
| `demo/framing-clip2.png` | the real UI: five tools live, `concord_commit` struck through |
| `demo/cards/03-forge.png` | "Seven of these used to get through" |
| `demo/cards/x-refusal.png` | the refusal, with no button on it |
| `demo/cards/x-recovery.png` | crash recovery |
| `demo/cards/x-receipt.png` | the receipt, checked on an origin we do not run |
| `brand/concord-banner.png` | the mark |

---

## 8. Submitter type

```
Individual
```

---

## 9. Country of residence

**[YOU]** — pick yours. Note the excluded list: Belarus, Brazil, China, Crimea,
Cuba, Donetsk PR, Hong Kong, Iran, North Korea, Luhansk PR, Quebec, Russia,
Syria, Venezuela.

---

## 10. Organization name

Leave blank — submitting as an individual.

---

## 11. App status

```
New
```

Built entirely inside the submission window. First commit **2026-09-01**, 60+
commits through **2026-09-03**, all public in the repo's history. Nothing here
predates the hackathon.

---

## 12. If existing, what you updated

Not applicable — see above.

---

## 13. Live URL for judges

```
https://concord-coordinator.vercel.app
```

---

## 14. Testing instructions

*(Judge-facing and not public. Paste as-is.)*

```
No credentials, no signup, nothing to install. Everything is free and open.

FASTEST PATH (about five minutes, nothing to type):
https://concord-coordinator.vercel.app/judge.html
Five claims, each with the one link that shows it.

IF YOU HAVE TWO MINUTES INSTEAD, do these two things on
https://concord-coordinator.vercel.app :

1. Paste:  Book me London for three nights — flight, hotel and the visa fee.
   Open your tool inspector, or the "what the agent can see" panel on the page,
   BEFORE you click anything. There is no concord_commit in getTools(). The agent
   proposes, and reads the guarantee out — the surface still does not change,
   because explaining is not consent. Click "Accept this guarantee" and watch
   concord_commit get registered by that click. It is unregistered again the
   moment the commitment starts.

2. Paste:  Book me the visa fee and the entry permit.
   Two things nobody can take back. It refuses, says nothing was contacted, and
   there is no button on that answer.

WORTH THIRTY SECONDS EACH:
- https://concord-coordinator.vercel.app/attack.html
  Fire fourteen forged receipts at our own verifier. Seven used to get through.
- https://concord-receipts.vercel.app
  Check a receipt on an origin we do not run. The coordinator is never contacted.
- https://concord-coordinator.vercel.app/native.html
  Tells you whether your browser has native WebMCP and which behaviours hold.
- https://concord-sandbox.vercel.app
  Write your own participant in ten lines; it joins the next commitment.
- https://concord-coordinator.vercel.app/conformance.html
  Point it at any origin, including your own.

BROWSER: best in Chrome 149+ with WebMCP enabled
(chrome://flags/#enable-webmcp-testing, or the origin trial). Verified on Chrome
151. Without native WebMCP the page installs a spec-faithful polyfill and every
claim above still holds — /native.html tells you which you are on, honestly.

REPRODUCING THE EVIDENCE: clone the repo and run `npm run check`. No dependencies
to install. It runs 163 assertions, the model checker, the forgeries, the surface
matrix against the live deployment, a receipt round trip to another origin, and a
crash-and-recover — in about four minutes.
```

---

## 15. Public code repository

```
https://github.com/iamdflame/concord
```

Verified public, MIT, and GitHub shows the licence in the About section.

---

## 16. Which agents/clients did you test your WebMCP tools with?

```
Google Chrome 151 with native WebMCP (chrome://flags/#enable-webmcp-testing) —
provider=native confirmed against the live deployment, with the integration suite
and all five participants at conformance L3.

Chrome for Testing 151, headless, driven over the Chrome DevTools Protocol — this
is what CI uses, so every claim about the tool surface is re-checked on the real
API rather than on a shim.

The coordinator's own in-page agent, which calls only through
document.modelContext (getTools / executeTool), so it is a WebMCP client and not
a privileged back door.

A spec-faithful polyfill for browsers without WebMCP; /native.html reports which
implementation you are actually on rather than assuming.
```

**[YOU]** If you also opened it in **ChatGPT's in-app browser**, add that line —
the form asks and it is worth saying. If you did not, leave it out; do not claim
a client you did not test.

---

## 17. Which AI tools have you leveraged?

```
OpenAI Codex, and ChatGPT alongside it — used through the build, from working
out the protocol design to writing and reviewing code.

Claude Code (Claude Opus 5) — implementation, adversarial review and test design,
including the audit that found the receipt verifier accepting 7 of 14 forgeries,
and the mutation-testing pass that caught our own property tests passing
vacuously.

Using two independent models against each other turned out to be the useful part
rather than an accident of tooling. The most valuable results in this project
came from one of them attacking what the other had built and finding it wanting —
the forged-receipt audit, the discovery that a sampled mutation score was
flattering us, and the finding that a property test which registered the commit
tool in 1% of the states it checked was passing for the wrong reason. A single
assistant reviewing its own work agrees with itself.
```

**[YOU]** The Codex line is deliberately general, because I should not invent
specifics about your sessions. Sharpen it — one concrete thing you had Codex do
is worth more than three vague ones, and this is the one answer where a judge
cannot check you but a reader can tell the difference.

---

## 18. Level of learning derived

**[YOU]** — a dropdown. Answer honestly; there is no scored answer.

---

## 19. Did you gain AI value for your career?

**[YOU]** — a dropdown. Same.

---

# Before you hit submit

1. ~~Deploy.~~ **Done.** Every judge-facing page returns 200, the surface matrix
   passes against production, and `/native.html` reports `provider=native`.
2. **Confirm the YouTube video is Public**, not Unlisted. This is the last thing
   I cannot check for you — an unlisted video can disqualify. Open it in a
   signed-out private window.
3. Upload `demo/devpost-thumb.png` as the thumbnail.
4. Paste the story, check the tables rendered, and check every "Try it out" link
   resolves.
5. **The project name is yours to decide.** The organisers say not to let AI name
   your project. "Concord" is the name the repository has carried from its first
   commit; the subtitle "— an agent that cannot overpromise" is a line I wrote.
   Keep it, cut it to plain "Concord", or replace it — but make it your call
   rather than mine.
