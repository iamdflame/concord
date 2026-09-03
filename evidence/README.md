# Evidence

Output from real runs, committed so the claims in the README can be checked
without installing anything. Regenerate with `npm run evidence`.

| File | What it is |
|---|---|
| `tests.txt` | the protocol suite, no browser |
| `attacks.txt` | every forged receipt, and what the verifier objected to |
| `surface.txt` | the tool surface asserted state by state, against the live deployment |
| `live.txt` | every deployed origin checked from outside |
| `mutation.txt` | how many deliberate defects the suite catches |

None of this is a substitute for running it yourself. `npm run check` does all
of it at once, and `tools/check.sh` is forty lines you can read first.
