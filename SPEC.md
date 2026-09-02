# The Concord Commitment Protocol

**Version 1 · draft · September 2026**

## 1. Abstract

WebMCP lets a site declare what a tool *does*. It does not let a site declare
what a tool can *undo*. `inputSchema` describes shape; `readOnlyHint` describes
whether an effect exists. Nothing describes whether an effect can be reversed.

An agent acting across several sites needs that. Booking a flight on one site
and a hotel on another, it cannot know — before it starts — whether a failure
halfway through leaves a charge nobody can take back. Today that gap is filled
by a marketplace: an intermediary both sites have a contract with, which is why
one exists between almost every pair of businesses that transact through an
agent.

This document defines a convention over WebMCP by which a site declares its
**commitment surface**, and an algorithm by which a coordinator computes the
strongest guarantee available across several such sites **before contacting any
of them** — and refuses when there is none.

## 2. Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted
as described in RFC 2119.

**Participant** — an origin that publishes a commitment declaration.
**Coordinator** — the document that discovers participants and orders calls
between them. It is not trusted by anybody, including the user.
**Commitment** — one attempt to carry out a set of steps across participants
such that either all of them stand or none does.
**Statement** — a signed assertion by a participant about one step it performed.
**Receipt** — the set of statements a commitment produced, with proofs.

## 3. The declaration tool

A participant MUST register a WebMCP tool named `concord.protocol`. It MUST be
`readOnlyHint: true`, MUST perform nothing, and MUST return:

```json
{
  "id": "fly",
  "title": "Northwind Air",
  "origin": "https://northwind.example",
  "keyId": "67273155ad928e35",
  "steps": {
    "reserve": { "tool": "hold_seat", "ttlSeconds": 900 },
    "confirm": { "tool": "ticket_seat" },
    "cancel":  { "tool": "release_seat" },
    "status":  { "tool": "concord.status" }
  }
}
```

`origin` MUST equal the participant's own origin. `keyId` MUST identify a key
published under §10. A participant MUST expose these tools to the coordinator
via `registerTool`'s `exposedTo`, and the coordinator MUST discover them via
`getTools({ fromOrigins })`. Consent is therefore required on both sides, and
enforced by the browser rather than by this protocol.

A participant MAY declare `irreversible: true` and a human-readable `note`.

## 4. The commitment ladder

A declaration maps to exactly one rung:

| Rung | Requires | Meaning |
|---|---|---|
| **reservable** | `reserve` + `confirm` + `cancel` | Nothing observable happens until every participant has agreed |
| **compensable** | `execute` + `compensate` | The effect happens and is then reversed; it is briefly real |
| **irreversible** | `execute` | Once done, done |

A declaration matching none of these is **unusable**. A coordinator MUST NOT
guess a rung, and MUST refuse a plan containing an unusable participant.

Classification MUST use only the declaration. A coordinator MUST NOT infer
reversibility from a tool's name, description, or `readOnlyHint`.

## 5. Guarantee computation

Given a set of participants, a coordinator MUST compute one of four answers
**before contacting any participant**.

| Guarantee | When |
|---|---|
| **atomic** | every participant is reservable |
| **compensated** | at least one compensable, no irreversible |
| **bounded** | exactly one irreversible participant, and it can be ordered last |
| **refused** | otherwise |

A plan MUST be refused when:

- two or more participants are irreversible — if the second fails, nothing can
  undo the first, and no ordering helps;
- an irreversible participant has a declared dependant, so it cannot be ordered
  last;
- any participant is unusable (§4);
- the declared dependencies contain a cycle.

`atomic` MUST NOT be described as leaving no possibility of partial commitment.
See §15.2.

A coordinator MUST report, alongside the guarantee:

- **the ordering** it will use;
- **the point of no return**, if any — the participant past which nothing can be
  undone;
- **which effects become briefly real** before being reversed;
- **which participants cannot be asked afterwards what happened** (§8). A
  participant without a `status` step turns any interruption into a permanent
  unknown, and a guarantee computed without saying so is not the honest one.

## 6. Phase order

A coordinator MUST execute in this order:

```
1  reserve    every reservable participant takes a hold      cancellable
2  execute    every compensable participant commits          reversible, visibly
3  commit     the one irreversible participant runs          point of no return
4  confirm    reservations become bookings
```

**Confirm MUST come last.** A confirmed reservation cannot be cancelled, so
confirming before the irreversible step would strand it if that step failed.
This ordering leaves exactly one operation after the point of no return, and it
is the one the participant has already promised to honour.

Before phase 4 a coordinator MUST check each reservation's remaining TTL and
MUST NOT attempt to confirm an expired hold; an expired hold is a diagnosis, not
a failure to discover by attempting.

On failure a coordinator MUST unwind in reverse order of execution:
compensations first, newest first, then cancellations. It MUST record a failed
compensation rather than treating it as reversed (§15.1).

## 7. Idempotency keys

Every commitment step MUST take an `idempotencyKey` as a declared parameter. It
MUST be derived as:

```
idempotencyKey = "<sagaId>.<participantId>.<step>"
```

`sagaId` MUST be unpredictable; implementations SHOULD use `crypto.randomUUID()`.
A participant MUST return the result it produced the first time it honoured a
key, without performing the work again. A coordinator MUST use the same
derivation for a step and for the reversal of that step, in both the live path
and in recovery — differing derivations for the same logical operation permit
double compensation.

## 8. The status probe

A participant SHOULD register `concord.status`, `readOnlyHint: true`:

```
concord.status({ lookupKey })  →  { happened: boolean, result: object | null }
```

It MUST perform nothing. It MUST NOT reuse the name `idempotencyKey` for its
parameter: every commitment step declares one for its own call, and a probe that
reuses the name has the key it is asking about overwritten by the key of the
asking.

A coordinator MUST probe before treating a thrown call as a call that did not
happen — a lost reply is not a failure — and MUST probe before reversing an
uncertain step during recovery. A participant that declares no `status` step
MUST be reported as unresolved rather than assumed either way: assuming a step
did not happen strands the effect, and assuming it did reverses something that
never occurred.

## 9. Attestation

Every commitment step MUST return, alongside its result, a statement signed by
the participant:

```json
{
  "sagaId":         "saga_dc1cc3f1-…",
  "origin":         "https://northwind.example",
  "vendor":         "fly",
  "parties":        ["fly", "stay", "visa"],
  "plan":           { "parties": [...], "guarantee": "bounded", "steps": [...] },
  "step":           "confirm",
  "idempotencyKey": "saga_dc1cc3f1-….fly.confirm",
  "at":             "2026-09-01T20:28:28.567Z",
  "result":         { "ref": "NW9F2A1C", "ticketed": true, "minor": 74200 }
}
```

`origin` MUST be the participant's own origin, inside what it signs. A verifier
resolves the key from this field and from nowhere else (§12); an origin supplied
by the coordinator lets the coordinator name itself as any party.

`plan` MUST describe the whole commitment, not the participant's part of it.
Signing only one's own part permits a coordinator to drop a statement and
rebuild the receipt around what remains.

Statements MUST be canonicalised per **RFC 8785** and signed **ES256**. The
signature MUST cover the statement and MUST NOT be part of the leaf (§11).

The signing key MUST NOT be held by the page. A participant SHOULD sign
server-side, from its own transaction record, and MUST NOT sign a statement
naming another participant or another origin.

## 10. Key publication

A participant MUST publish at `/.well-known/concord.json` **on its own origin**:

```json
{
  "concord": 1,
  "vendor": "fly",
  "origin": "https://northwind.example",
  "keys": [{
    "keyId": "67273155ad928e35",
    "alg": "ES256",
    "publicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
    "notBefore": "2026-01-01T00:00:00Z",
    "status": "active"
  }]
}
```

This is the anchor. TLS proves a verifier reached the origin it asked for; the
document's `vendor` field proves that origin claims to be the party named. Both
checks are required.

Withdrawal has two meanings and they differ for existing receipts:

- `"status": "rotated"` with `retiredAt` — statements signed while the key was
  live remain valid; later ones do not.
- `"status": "compromised"` with `compromisedSince` — nothing dated after that
  moment can be trusted however cleanly the signature verifies, while statements
  made before it survive.

## 11. The receipt

A receipt is a Merkle tree over the statements a commitment produced.

```
leaf(statement) = SHA-256("leaf:" ‖ canonical(statement))
node(a, b)      = SHA-256("node:" ‖ a ‖ b)
```

An odd node at any level MUST be **promoted** to the next level, not hashed with
a copy of itself. Duplicating the tail makes `[a,b,c]` and `[a,b,c,c]` share a
root, which turns an inclusion proof into a forgery.

A leaf MUST commit to the statement and MUST NOT commit to the signature over
it. Hashing both collapses two different accusations into one: an altered record
and a statement its named party never made are different claims about different
people, and a receipt should be able to say which.

An inclusion proof is the sibling hashes on the path to the root. A participant
verifies its own entry from its own statement, its proof, and the root — and
learns nothing else, because a proof is opaque hashes. This is not decoration:
airlines do not reveal fares to hotels, and a receipt that made disclosure the
price of verifiability would not be adopted.

## 12. Verification

A verifier MUST, given only a receipt:

1. Recompute the root from the entries. A mismatch MUST be reported, and
   per-entry results MUST still be reported — the reader needs to know which
   entry moved, not only that one did.
2. Reject any entry whose `statement.sagaId` differs from the receipt's.
3. Require every entry to carry the same `plan`.
4. For each entry, resolve the key by fetching
   `statement.origin + "/.well-known/concord.json"`, and reject if that document
   names a different vendor. A verifier MUST NOT resolve a key from any
   coordinator-supplied mapping.
5. Verify the signature over `canonical(statement)`.
6. Verify the key was **in force** at `statement.at` (§10). A signature that
   verifies with a key that was not entitled to sign is worse than none, because
   it looks like one.
7. Check completeness against the signed `plan`:
   - if the receipt claims `committed`, every planned step MUST have a statement
     and every party MUST have at least one;
   - otherwise, missing steps and silent parties MUST be reported as
     observations, not failures. A commitment that unwound has no confirm
     statement, and a participant whose step failed has nothing to sign.

A verifier MUST NOT require anything from the coordinator. `npx concord-verify`
and `tools/verify-receipt.mjs` implement this.

## 13. Conformance levels

| Level | Requires |
|---|---|
| **L1 — declares** | `concord.protocol`, exposed to the coordinator, honest about its rung |
| **L2 — recoverable** | L1 plus `concord.status` and idempotent steps |
| **L3 — attesting** | L2 plus signed statements and a published key document |

A coordinator MUST compute guarantees for L1 participants and MUST say that an
L1 participant cannot be asked what happened (§5).

## 14. Security considerations

See `THREAT-MODEL.md`.

## 15. Open questions

These are unresolved. They are written down because a specification that hides
its limits is asking to be trusted rather than checked.

### 15.1 A participant may declare a reversal it will not honour

Nothing here prevents a participant declaring itself compensable and then
refusing to compensate. A declaration is a claim about the future and no
protocol binds one.

What this protocol does is make the lie **attributable**: the participant's own
signature is on the statement saying it acted, and on the plan naming it
compensable, so its refusal is a documented breach rather than a dispute about
what happened. **Concord converts an unenforceable promise into an attributable
one. That is the contribution, and it should be stated plainly rather than
hedged.**

### 15.2 Confirm fan-out is not atomic

With three reservable participants, confirm #3 can fail after #1 and #2 have
committed. This is ordinary two-phase-commit non-atomicity and no in-tab
protocol removes it: it requires a coordinator both parties trust, which is the
thing this design says does not exist. It needs participant-side prepared
transactions.

The protocol's obligation is to say so before the commitment rather than after
it, and to name exactly what stands.

### 15.3 The coordinator sees everything

Selective disclosure protects participants from each other, not from the
coordinator. The coordinator orders the calls and assembles the receipt, so it
sees every price. The intermediary does not disappear; it becomes the user's,
disposable and margin-free, and unable to misreport because every statement is
signed by the counterparty. That is a smaller claim than "no intermediary" and
it is the true one.

### 15.4 Reversal statements are not planned

`plan.steps` names forward steps. Cancellations and compensations are accepted
in a receipt without being enumerated in advance, so a coordinator could add a
reversal statement that no plan called for. It would still have to be signed by
the participant that made it.

### 15.5 No cross-commitment binding

Two commitments run back to back are independent. Nothing prevents a coordinator
running one, discarding its receipt, and presenting only the second.

### 15.6 A signer cannot promise to sign a key only once

A participant SHOULD refuse to produce two different statements under one
idempotency key. It cannot guarantee it: on a serverless deployment the memory
that would enforce it is per-instance. Verification therefore rejects a receipt
containing two different statements under one key (§12), which bounds the
consequence rather than preventing the act.

### 15.7 Statement timestamps are self-asserted

`statement.at` comes from the participant. Key validity windows (§10) compare
against it, so a participant with a manipulated clock can place a statement
inside a window it should not be in. There is no trusted timestamping here.
This weakens the compromised-key story: it bounds a *third party* holding a
stolen key, not the participant itself.

### 15.8 The declaration is not versioned

`concord.protocol` returns no version field. A participant changing its
commitment surface between discovery and execution is not detected.

## 16. Upstream

This convention exists because WebMCP has no way to express reversibility. The
natural home for it is the annotation block:

```js
annotations: {
  readOnlyHint: false,
  commitment: 'reservable' | 'compensable' | 'irreversible',
  reverses: 'release_seat',
  ttlSeconds: 900,
}
```

`readOnlyHint` already establishes that WebMCP cares about the category of a
tool's effect. Reversibility is the next axis, and an agent needs it to plan
safely rather than to act hopefully.
