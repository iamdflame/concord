# Submission

**Live:** <https://concord-coordinator.vercel.app>
**Repository:** <https://github.com/iamdflame/concord>
**Verify a receipt yourself:** `npx concord-verify receipt.json`
([on npm](https://www.npmjs.com/package/concord-verify) — nothing of ours runs)
**Conformance, in your browser:** <https://concord-coordinator.vercel.app/conformance.html>

## In three sentences

Every site tells an agent what it can do. No site tells an agent what it can
undo — so an agent booking a flight on one site and a hotel on another cannot
know, before it starts, whether a failure halfway through leaves you with a
charge nobody can reverse. Concord is a WebMCP convention that lets any site
declare its commitment surface — *hold and release*, *commit and compensate*, or
*irreversible* — and an in-browser coordinator that computes what can honestly
be promised across several sites **before contacting any of them**, then refuses
when the honest answer is that atomicity is not available at any price. The
result is an agent that is structurally incapable of overpromising: not because
it was prompted carefully, but because the only tools it can reach will not let
it.

## Why this use case is a strong fit for WebMCP

It needs precisely the thing WebMCP uniquely provides and nothing else does: two
mutually distrusting origins' authenticated, typed capabilities present in one
execution context, under the user's authority, with consent enforced on both
sides by the browser.

That is not scraping and it is not an API partnership. A participant grants with
`registerTool`'s `exposedTo`; the embedder grants with `allow="tools"`; the
coordinator must ask by name with `getTools({ fromOrigins })`. Three separate
grants, none of which any party can forge, and none of which requires the
participants to have heard of each other.

And it fills a gap in the standard rather than decorating it. `inputSchema`
describes shape. `readOnlyHint` describes whether an effect exists. **Nothing in
WebMCP describes whether an effect can be reversed** — which is the one fact an
agent needs in order to plan across sites rather than to act and hope.
[SPEC.md §16](SPEC.md) proposes the annotation upstream.

## How it creates a better user experience

The agent tells you what it can promise **before** it acts, refuses when the
honest answer is "nothing", and hands you a receipt you can verify without
trusting it.

Contrast with the status quo: an agent that books three things and tells you it
went fine. The failure mode of agentic commerce is not the booking — it is the
agent reporting a success it did not achieve.

Concretely, on the live URL:

- Ask for a flight, a hotel and the visa fee. The agent reads back what it can
  promise, which step is the point of no return, and which charge will become
  briefly real before being reversed. Only then does a **Go ahead** button exist.
- Ask for a flight, the visa fee **and** the entry permit — two things nobody can
  take back — and it says it cannot do that as one commitment and that nothing
  has been contacted. There is no button on that answer.
- Break a vendor mid-commitment with the switches on its own page and watch the
  reversals happen on the vendors' own sites.

## What people and agents can do together that was difficult or impossible before

Commit atomically across businesses that have no relationship, no shared
coordinator, and no reason to trust each other — with the failure semantics
computed in advance and stated in plain language before anything is touched.

Today that requires a marketplace that both businesses have a contract with, and
those marketplaces charge in the region of 15–30% to stand in the middle.
Concord does not remove the intermediary; it makes it yours — disposable,
margin-free, and unable to misreport what happened, because every statement in
the receipt is signed by the counterparty rather than by the coordinator.

The part that is genuinely new is the **refusal**. An agent that can decline to
promise, with a reason computed from declarations rather than from a policy
someone wrote, is not something that existed before.

## How WebMCP is implemented

- **`document.modelContext.registerTool`** — participants register their
  commitment steps; the coordinator registers the four tools an agent may reach
  (`concord_list_vendors`, `concord_propose_commitment`,
  `concord_explain_guarantee`, `concord_commit`).
- **`exposedTo`** — every participant exposes its tools only to the coordinator's
  origin, so cross-origin consent is explicit on the participant's side.
- **`allow="tools"`** plus a `Permissions-Policy: tools=(self "…")` response
  header — the embedder's half of the same consent, verified on every deployed
  origin by `deploy/verify-live.mjs`.
- **`Origin-Agent-Cluster: ?1`** — required for cross-document tool access;
  without it `getTools()` returns empty with no error.
- **`getTools({ fromOrigins })`** — discovery is opt-in on both sides.
- **`executeTool(tool, jsonString)`** — arguments are passed as a JSON string,
  per Chrome's imperative API.
- **`toolchange`** — the coordinator re-derives when the set of participants
  changes.
- **`annotations.readOnlyHint`** — used honestly: `true` on `concord.protocol`
  and `concord.status`, which perform nothing, and on nothing that acts.
- **`AbortSignal`** — a deadline on every call, handed to the participant and
  also enforced by the coordinator, which does not assume a participant honours
  cancellation.

**Verified on the native API.** On Chrome 151 against the live deployment the
harness reports `provider=native`, the integration suite passes 20/20, and all
five participants reach conformance L3. Open
<https://concord-coordinator.vercel.app/native.html> in any browser and it will
tell you which implementation you have and whether each behaviour this depends
on holds there.

Running it natively is also what found the two defects a polyfill can never
surface: the coordinator was not delegating `tools` to the origins it embeds,
so every participant registered and none was discoverable; and Chrome returns
`inputSchema` as a JSON string where the polyfill returns an object. Both are
fixed, and both worked flawlessly under the shim — which is the argument for
never trusting one.

**Where WebMCP is unavailable** the project installs a spec-faithful polyfill
over `postMessage` and says which is running on every single run.

## Objections, answered before they are raised

**"This is just two-phase commit in a browser."** 2PC needs a coordinator both
parties trust and a shared commit interface. Neither exists across independent
sites. The contribution is the **declaration layer** — computing the guarantee
from what sites say about themselves, before contact — and the refusal when
there is none. The saga is the easy part.

**"A vendor can lie about being compensable."** Correct, and Concord cannot
prevent it. Meridian Holdings does exactly that, on purpose, on the live URL.
What Concord does is make the lie attributable: the vendor's own signature is on
the statement it later declines to reverse. Stated in [SPEC.md §15.1](SPEC.md).

**"The safety is prompt engineering."** `concord_commit` refuses any proposal
whose guarantee has not been read back, and any plan the ladder would not
guarantee. There is no tool on the agent's surface that moves money. Nine tests
assert this, including that explaining a refusal does not unlock it.

**"You still have an intermediary."** Yes. Said first, in the README's opening.

**"Confirm fan-out is not atomic."** Correct, and documented as an open question
with the reason no in-tab protocol can fix it
([SPEC.md §15.2](SPEC.md)).

**"The vendors are fake."** They are reference implementations, and the
conformance suite that judges them is published: point
<https://concord-coordinator.vercel.app/conformance.html> at your own origin.

## Numbers

80 unit tests over the protocol with no browser · 6 browser suites against real
origins · 5 participants at conformance level L3 · 6 independent HTTPS
deployments · 0 backends in the commitment path.
