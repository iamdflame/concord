# Ring 0

A capability kernel for the agentic web, and the substrate Concord was built on.

It treats every origin as a process and every tool as a syscall, then schedules,
labels and records the calls between them. WebMCP ships a taint bit
(`untrustedContentHint`) and an effect bit (`readOnlyHint`) and enforces
neither; Ring 0 is the layer that acts on them.

It is a **different argument** from Concord's, kept here because it is where
several of Concord's ideas were worked out — the hash-chained transcript, the
write-ahead journal, and the habit of refusing rather than guessing.

Its pages are served from this directory; its three supervised processes are
separate origins on `:5174` (mail), `:5175` (ledger) and `:5176` (pay).

```bash
npm run dev            # every origin, Concord's and Ring 0's
npm run probe:01       # interception
npm run probe:02       # the policy gate
npm run probe:03       # composition
npm run probe:04       # replay
```

## What it demonstrates

A scripted agent reads a mail thread carrying an instruction written by an
attacker and does exactly what it was told. The transfer is refused before it
executes, and the refusal names the field and the source:

```
to="acct_attacker_9f" from http://localhost:5174/read_thread
```

The interesting part is not the attack. It is that the legitimate payee arrived
in the same untrusted email, because invoices come by mail — so refusing
untrusted content refuses the real payment for the same reason it refuses the
fake one. What separates them is whether an independent origin that is not a
taint source asserts the same value. The ledger records where each vendor is
actually paid; nothing but the forged notice names the attacker's account.

`ring0/monitor.html` reconstructs any instant of a session from the transcript.
Nothing is snapshotted: dragging the timeline replays what crossed the boundary
through a fresh provenance, so the past shows a system that has not been
attacked yet rather than a dimmed copy of the present.

43 assertions across four phase suites.
