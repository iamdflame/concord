# concord-verify

Verify a [Concord](https://github.com/iamdflame/concord) receipt without
trusting the coordinator that produced it.

```bash
npx concord-verify receipt.json
```

```
receipt   receipt.json
saga      saga_dc1cc3f1-eda1-40af-9fc3-8b7d15162605   committed
root      c2ee3b7d5e504306a99a90ceb46045503cad06915a5a687690634461ef8f15fe

  resolving fly → https://concord-fly.vercel.app/.well-known/concord.json
  resolving stay → https://concord-stay.vercel.app/.well-known/concord.json
  resolving visa → https://concord-visa.vercel.app/.well-known/concord.json

  ✓ fly     reserve    in tree yes   signed yes   key in force
  ✓ stay    execute    in tree yes   signed yes   key in force
  ✓ visa    execute    in tree yes   signed yes   key in force
  ✓ fly     confirm    in tree yes   signed yes   key in force

VERIFIED — 4/4 statements signed by the party named and provably part of this receipt.
```

## What it checks

A Concord receipt records a commitment carried out across several independent
businesses that have no agreement with each other. The coordinator that ordered
those calls is the one party with both the motive and the position to
misreport, so nothing here takes its word for anything.

- **The root.** Every statement is a leaf of a Merkle tree; altering one changes
  the root.
- **The signatures.** Each statement is signed by the participant that made it,
  ES256 over its RFC 8785 canonical form.
- **The keys, resolved from the participant's own origin.** Not from any mapping
  the coordinator wrote — that map is exactly what a dishonest coordinator would
  forge. The key is fetched from `origin/.well-known/concord.json`, and an
  origin that identifies itself as a different party is rejected.
- **Whether the key was entitled to sign.** A key retired before the statement's
  date, or reported compromised since before it, does not vouch for anything
  however cleanly the maths checks out.
- **Completeness.** Each participant signs the shape of the whole commitment, so
  a receipt with a statement quietly removed is one whose survivors testify that
  something is missing.

A failure is a claim about a specific party rather than a generic error:

```
  in tree NO         the statement was altered or was never part of this receipt
  signed NO          the statement is in the receipt but that vendor never made it
  key NOT IN FORCE   the signature checks out, but the key was not entitled to sign
```

Add `--explain` to print the algorithm as it runs.

## As a library

```js
import { verifyReceipt, originResolver } from 'concord-verify';

const { ok, findings, complaints, notes } = await verifyReceipt(receipt, originResolver());
```

Pass your own resolver — `(vendor, origin, keyId) => publicKeyRecord` — to verify
offline or against a directory you control.

## What it does not do

It cannot tell you a participant was honest about what it *would* do. A vendor
can declare that it is able to reverse something and then refuse to. What this
gives you is that the refusal is attributable: the vendor's own signature is on
the statement saying it acted, and on the plan naming it reversible.

That limit, and the others, are written down in
[SPEC.md §15](https://github.com/iamdflame/concord/blob/main/SPEC.md) and
[THREAT-MODEL.md](https://github.com/iamdflame/concord/blob/main/THREAT-MODEL.md).

## Version

`0.1.0`, tracking **SPEC v1 draft**. The receipt format is specified but the
specification is a draft, and saying otherwise would be the kind of claim this
project exists to avoid making.

MIT.
