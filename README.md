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

## Tests

```bash
node --test concord/ladder.test.mjs concord/saga.test.mjs   # 20, pure logic
npm run probe:concord                                        # 10, real origins
```

The protocol core is pure and tested without a browser: ordering, reverse
unwind, idempotency keys stable across retries, in-doubt reporting, failed
compensation surfaced, and refusal *before* any vendor is contacted. The
integration suite then proves it survives contact with three separately written
origins, including breaking one while it runs.

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
server.mjs          two origins with Origin-Agent-Cluster and Permissions-Policy
kernel/labels.mjs   the taint lattice and provenance tracker
kernel/policy.mjs   policy parser and evaluator
kernel/policy.ring  the capability policy itself
kernel/dispatch.mjs the gate every kernel tool call passes through
kernel/monitor.html the instrument — syscall trace and time-scrub
kernel/transcript.mjs hash-chained log and reconstruction
kernel/origins.mjs  the three supervised processes
kernel/             :5173 — Ring 0 and the phase suites
mail/               :5174 — untrustedContentHint; authors none of what it returns
ledger/             :5175 — read-only; the corroborating party
pay/                :5176 — send_funds, irreversible, the effect being guarded
shared/process.css  common chrome for the processes
shim/webmcp.mjs     spec-faithful WebMCP for browsers that lack it
shim/adapter.mjs    native-first resolution; reports which provider you got
tools/probe.mjs     headless Chrome over CDP
```

## Next

Phase 05 is the completeness sweep: empty states, first run, mid-flight cancel,
refresh, a permalink to a transcript instant, keyboard-only trace navigation,
and a live text field where anyone can write their own injection and watch the
kernel hold.

MIT.
