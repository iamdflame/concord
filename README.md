# Concord

**Two independent websites cannot agree on anything.**

No shared coordinator, no contract, no trust between them. That is not a
technical detail — it is why Booking.com, Expedia, Amazon Marketplace and every
other marketplace exists. They are the intermediary two parties need because
there is nowhere neutral to transact, and they charge 15–30% for standing
there.

So everyone knows you cannot book a flight on one site and a hotel on another
*atomically*, where a failure at the hotel reverses the flight. Both vendors
would need to share a transaction coordinator, and they never will.

That assumption was never retested, because until now there was no neutral
execution context holding both parties' authenticated sessions at once.
**A browser tab is now that context.** WebMCP puts both vendors' typed,
executable capabilities in one place, under the user's authority, with
cancellation as a first-class primitive.

Concord is the protocol that uses it: multi-vendor commitments made atomic with
no API partnership, no backend, and no intermediary taking margin.

```bash
npm run dev            # seven origins
npm run concord        # the coordinator
```

Then open <http://localhost:5173/concord.html>, and break a vendor while it runs.

## The hard part is refusing to lie

A saga over irreversible steps is not atomic. Discovering that *after* the
failure is the difference between a demo and a system, so Concord classifies
what each vendor can actually commit to and computes the guarantee **before
anything is contacted**.

| Rung | Declares | Meaning |
|---|---|---|
| **reservable** | `reserve` + `confirm` + `cancel` | Nothing observable happens until every participant agrees |
| **compensable** | `execute` + `compensate` | The effect happens and is then reversed — a charge appears and refunds |
| **irreversible** | `execute` only | Once done, done |

From that, one of four honest answers:

- **atomic** — every vendor holds a reservation
- **compensated** — some effects become briefly real, then reverse
- **bounded** — one irreversible step, ordered last, everything before it unwinds
- **refused** — no promise is available, and nothing is contacted

Two irreversible vendors is the refusal case: if the second fails, nothing can
undo the first. Concord says so and stops. An irreversible step that something
must *follow* is refused for the same reason.

## Phase order is the safety property

```
1 reserve    every reservable vendor takes a hold          cancellable
2 execute    every compensable vendor commits              reversible, visibly
3 commit     the one irreversible step runs                point of no return
4 confirm    reservations become bookings
```

Confirm comes last deliberately. A confirmed reservation cannot be cancelled, so
confirming before the irreversible step would strand it if that step failed.
This leaves exactly one operation after the point of no return, and it is the
one the vendor has already promised to honour.

It can still fail. Then there is no unwind, and pretending otherwise would be
the lie this design exists to prevent: the saga retries confirm under the same
idempotency key, and if that is exhausted it reports **IN DOUBT**, naming what
is stranded and what becomes of it. Failed compensations are recorded the same
way — someone has to fix those by hand.

## Surviving the coordinator

A saga held in memory is a demo. Close the tab after Rowan House has been
charged and $567 is stranded, with nothing anywhere that knows to undo it.

So intent is written **before** each call, not after. The distinction is the
whole point: a log of outcomes cannot tell *"about to reserve"* from *"never
reserved"*, and those need opposite recoveries.

```
intent   stay.execute   key saga_8h.stay.execute
                        ← the coordinator dies here
```

That leaves an intent standing alone, which is exactly right — the process
stopped between the call and the reply, so only the vendor knows whether it
acted. Two consequences follow, and both are enforced:

- **A dead process unwinds nothing.** There is nothing left running to do it.
- **A dead process writes nothing**, including "this call failed". Only a live
  coordinator records a failure.

Recovery does not guess. The idempotency key was journalled before the call, and
every vendor exposes `concord.status` — *did you ever honour this key* — which
performs nothing. So the coordinator asks, and only then decides what to undo.

A vendor declaring no status step is reported **unresolved**, never assumed:
assuming it did not happen strands the charge, and assuming it did refunds a
booking that was never made.

Press **Commit, then kill the coordinator** on the coordinator page. It stops
two calls in, with the hotel charged. Reload, and the page says an interrupted
commitment was found and offers to resolve it:

```
Resolved — unwound
stay.execute undone via compensate
fly.reserve  undone via cancel
```

The exhaustive test crashes at every step boundary, both before and after the
vendor acted, and asserts that whatever really happened was undone exactly once.
It caught two real bugs: the confirm loop was retrying a dead process, and the
status probe named its parameter `idempotencyKey`, so the key it asked about was
overwritten by the key of the asking and recovery quietly found nothing.

## The participants

Three independent businesses with no relationship to each other, each at a
different rung. None has an API with another; none knows the others exist.

| | | |
|---|---|---|
| **Northwind Air** `:5177` | reservable | Holds a seat 15 minutes, then tickets or releases it |
| **Rowan House** `:5178` | compensable | Books and charges immediately; cancels with a full refund |
| **Consular Fee** `:5179` | irreversible | Declares no `compensate`, because inventing one would be a lie |

Each answers one question through a `concord.protocol` tool — *what can you
commit to* — and everything else is derived from the answers.

Every vendor carries operator switches that break any step on demand. Failure
injection is a feature of the system, not a mode of the test harness: break the
consular fee mid-commitment and watch the hotel refund and the seat release, on
the vendors' own pages.

## The receipt

Afterwards each party knows only its own half. Northwind knows it ticketed a
seat; Rowan House knows it charged and refunded. Neither knows what happened
elsewhere, and neither has any reason to trust the coordinator's account — the
coordinator is the traveller's agent, and it is the one party with a motive to
misreport.

So the receipt is not the coordinator's story. It is a Merkle tree over
statements **each vendor signed with a key held by that vendor's server**. The
coordinator can order those statements and prove the ordering. It cannot write
one, because it never holds a vendor's key.

The key is published at `/.well-known/concord.json` **on the vendor's own
origin**, and the receipt records where to look rather than carrying the key
itself:

```json
"vendors": { "fly": { "origin": "https://fly.example", "keyId": "e545001194dcf27a" } }
```

That is the anchor. A key handed over on the same channel as the claim it
authenticates proves nothing; a key fetched from the vendor over TLS is bound to
that vendor by the guarantee the web already provides. No registry, no CA of our
own, nothing extra to run — and the receipt still verifies in a year, because
the key outlives the tab.

### Verify one yourself

```bash
npm run verify receipt.json
```

Nothing from the coordinator is involved. The verifier reads the file, fetches
each vendor's published key from that vendor's origin, and reports per statement:

```
  ✓ fly     reserve    in tree yes   signed yes
  ✓ stay    execute    in tree yes   signed yes
  ✓ visa    execute    in tree yes   signed yes
  ✓ fly     confirm    in tree yes   signed yes

VERIFIED — 4/4 statements signed by the party named and provably part of this receipt.
```

A failure is a claim about a specific party rather than a generic error. Edit
what a vendor charged and the root breaks. Give a statement someone else's
signature and it reads `fly reserve — in tree yes, signed NO`, with the other
three still valid: the receipt names the bad statement instead of collapsing
into "invalid".

```
receipt root  7c67482c3a3b73eb3a09fb7a42cc29db0e33ac129f365df9f465159553ea1094   VERIFIED

fly    reserve   in the tree ✓   signed by fly  ✓
stay   execute   in the tree ✓   signed by stay ✓
visa   execute   in the tree ✓   signed by visa ✓
fly    confirm   in the tree ✓   signed by fly  ✓
```

The tree earns its place commercially, not just cryptographically. A vendor
verifies its own entry through an **inclusion proof made of opaque hashes** —
two of them here — without being shown what anyone else charged. Airlines will
not reveal fares to hotels, and a receipt that made disclosure the price of
verifiability would never be used.

Two details worth the trouble:

**A leaf commits to the statement, not to the signature over it.** Hashing both
collapses two different accusations into one. Keeping them apart means an edited
statement reports *the entries do not hash to the stated root*, while a borrowed
signature reports *in the tree, but this vendor never said it* — and the receipt
can say which party is being accused of what.

**An odd node is promoted, not hashed with a copy of itself.** Duplicating the
tail is the common shortcut, and it makes `[a,b,c]` and `[a,b,c,c]` share a
root, which turns an inclusion proof into a forgery.

The coordinator page has an *Edit one entry and re-verify* button, because the
claim is only worth as much as your ability to break it.

## Tests

```bash
npm test                 # 34, pure logic — ladder, saga, receipt, recovery
npm run probe:concord    # 18, real origins in a real browser
```

The protocol core is pure and tested without a browser: ordering, reverse
unwind, idempotency keys stable across retries, in-doubt reporting, failed
compensation surfaced, refusal *before* any vendor is contacted, inclusion at
every tree size, and the two forgeries above. The integration suite proves it
survives contact with three separately written origins — including breaking one
while it runs, and confirming that a coordinator which edits a vendor's
statement is caught by the vendor's own signature.

## Ring 0 — the substrate

Underneath Concord is a capability kernel: policy, information-flow labels, and
a hash-chained transcript that makes a cross-vendor commitment auditable. It
was built first, on its own terms, and its four phase suites still run.

## What Phase 01 does *not* prove

**WebMCP is in no stable browser.** It runs as a Chrome origin trial from 149 to
156, and the API is mid-rename from `navigator.modelContext` to
`document.modelContext`. This repository was developed against Chrome 134, so
the suite ran against `shim/webmcp.mjs`, a spec-faithful implementation of
`registerTool` / `getTools` / `executeTool` / `toolchange` and the `exposedTo`
and `fromOrigins` origin rules over `postMessage`.

That distinction is load-bearing and the probe prints it on every run: a green
suite against the shim proves the kernel's logic and proves nothing about the
platform. `shim/adapter.mjs` prefers native on both spellings and falls back
only when neither exists, so moving to a real Chrome 149+ is a browser upgrade,
not a code change.

The shim cannot enforce the `tools` permissions policy, which only a browser
can. The probe reports `tools-policy=absent` rather than implying otherwise.

## Requirements

Node 20+, and Chrome for the probe. Chrome 149+ with the WebMCP origin trial
(or `chrome://flags/#enable-webmcp-testing`) to run against the native API.

## Layout

```
concord/ladder.mjs        the commitment ladder — what can honestly be promised
concord/saga.mjs          the executor: phase order, deadlines, unwind
concord/journal.mjs       write-ahead log, durable across reloads
concord/recover.mjs       resolving a commitment its coordinator did not finish
concord/receipt.mjs       Merkle receipts, inclusion proofs, key validity
concord/client.mjs        binds the protocol to WebMCP
concord/*.test.mjs        the protocol proved without a browser

vendors/fly    :5177      reservable — hold, ticket, release
vendors/stay   :5178      compensable — book and charge, cancel and refund
vendors/visa   :5179      irreversible — declares no compensate, because there is none
kit/vendor.mjs            what every participant gets: protocol declaration,
                          idempotency, signing, status, break switches
kit/keystore.mjs          signing keys, published at /.well-known/concord.json
kit/canonical.mjs         RFC 8785 serialisation, so a stranger reaches the same bytes

kernel/concord.html       :5173 — the coordinator
kernel/concord-test.mjs   the protocol against three real origins
server.mjs                seven origins, with Origin-Agent-Cluster and Permissions-Policy
shim/webmcp.mjs           spec-faithful WebMCP for browsers that lack it
shim/adapter.mjs          native-first resolution; reports which provider you got

tools/export-receipt.mjs  run a commitment, write the receipt to a file
tools/verify-receipt.mjs  check that file, with nothing from the coordinator
tools/probe.mjs           headless Chrome over CDP

kernel/{labels,policy,dispatch,transcript,monitor}.*   Ring 0, the substrate
mail/ ledger/ pay/  :5174-6                            its three processes
experiments/tool-synthesis/                            a documented negative result
```

## Known limits

Stated here rather than left to be found.

**The native API is unverified.** This was built against Chrome 134, which
predates WebMCP, so every run reports `provider=shim`. `shim/adapter.mjs`
prefers native on both spellings and arguments go out as the JSON string
Chrome's API specifies, but nothing here has executed against the real
implementation. Run `npm run probe:concord` on Chrome 149+ with the origin
trial; if it prints `provider=native`, the platform claim is earned.

**A confirm fan-out can partially commit.** With several reservable vendors,
confirming is a sequence: a late failure leaves earlier confirms standing. That
is ordinary two-phase commit and cannot be removed without a coordinator both
sides trust, which is the thing this design says does not exist. The plan says
so before you commit, and the outcome names exactly what stands.

**The signing endpoint still takes its result from the page.** It will only sign
for its own vendor at its own origin, and only once per idempotency key, so a
compromised page cannot forge another party's word or restate its own. But
closing this properly means holding the vendor's transaction record server-side
and building the statement from it. That is the port a production deployment
has to make.

**Vendors keep their business state in the page.** Idempotency memory survives a
reload, which is what recovery depends on; inventory and bookings do not. Real
vendors have databases.

MIT.
