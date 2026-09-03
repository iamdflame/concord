#!/usr/bin/env bash
# Everything CI would run, runnable by anyone with the repository.
#
# It exists because CI is not a substitute for being able to check the project
# yourself, and because Actions is currently unavailable on this account.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── the protocol, no browser ──────────────────────"
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" || true

echo ""
echo "── the forge: every attack must be rejected ──────"
node attacks/run.mjs 2>&1 | sed -n '/^  [✓✗]/p;/^All\|^[0-9]* of/p' | sed 's/^/  /'

echo ""
echo "── the README describes this repository ──────────"
node tools/check-readme.mjs

echo ""
echo "── the demo fits in three minutes ────────────────"
node demo/timing.mjs 2>&1 | sed -n '/^  [✓✗]/p;/^DEMO/p' | sed 's/^/  /'

echo ""
echo "── the published verifier matches this repository ─"
node verify/build.mjs >/dev/null
git diff --quiet verify/lib && echo "  ✓ verify/lib is current" \
  || { echo "  ✗ verify/lib is stale — commit the regenerated files"; exit 1; }

echo ""
echo "── against real origins ──────────────────────────"
node server.mjs >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
until curl -sf -o /dev/null http://localhost:5181/; do sleep 0.3; done

# A probe that says nothing is not a probe that passed. `|| true` was printing
# an empty line for a page that timed out under load, which reads exactly like
# a page that was skipped and nothing like a page that failed.
verdict() {
  local out
  # `|| true` on the substitution, not on the line. Under `set -euo pipefail` a
  # grep that matches nothing fails the pipeline, fails the assignment, and
  # takes the whole script down at that line -- so the first flaky page ended
  # the run silently, which is the failure this function was added to prevent.
  out="$(URL="$1" node tools/probe.mjs 2>&1 \
    | grep -oE 'CONCORD (PASSED|FAILED)|NATIVE WebMCP is present|NO native WebMCP|PHASE [0-9]+ (PASSED|FAILED)|^PASS|^FAIL' \
    | head -1 || true)"
  echo "${out:-NO VERDICT — the page never reported one}"
}

for page in concord-test.html conformance.html native.html; do
  printf '  %-24s ' "$page"
  verdict "http://localhost:5173/$page"
done

echo ""
echo "── the surface: what an agent may call, and when ──"
# The central claim, checked through the same getTools() an agent would call.
# concord_commit must not exist until a person has accepted the exact guarantee
# they were shown, and must stop existing the moment that stops being true.
node evals/surface.mjs 2>&1 | sed -n '/^  [✓✗]/p;/^SURFACE/p' | sed 's/^/  /'

echo ""
echo "── a receipt, checked on an origin that is not ours ─"
# The claim is that a receipt survives leaving the coordinator. The only way to
# know is to take one somewhere else and ask, so that is what this does: run a
# real commitment, hand the receipt to the verifier origin in a URL fragment,
# and check both that an honest receipt passes there and that a tampered one
# does not -- without the coordinator being contacted either time.
RECEIPT="$(URL=http://localhost:5173/concord.html OUT=/dev/null SETTLE=14000 \
  DO='(async()=>{const $=id=>document.getElementById(id);
      $("q").value="Book me London for three nights — flight, hotel and the visa fee.";
      $("ask").requestSubmit();
      for(let i=0;i<150&&$("commit").hidden;i++)await new Promise(r=>setTimeout(r,120));
      $("commit").click();
      for(let i=0;i<200&&!globalThis.__CONCORD_RECEIPT__;i++)await new Promise(r=>setTimeout(r,100));
      $("verdict").textContent = btoa(String.fromCharCode(
        ...new TextEncoder().encode(JSON.stringify(globalThis.__CONCORD_RECEIPT__))));})()' \
  node tools/shot.mjs 2>/dev/null | head -1 | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).head||""))')"

printf '  %-24s ' "receipt handed over"
if [ -z "$RECEIPT" ]; then echo "NO RECEIPT PRODUCED"; else
  URL="http://localhost:5183/#r=$RECEIPT" OUT=/dev/null SETTLE=9000 \
  DO='(async()=>{const $=id=>document.getElementById(id);
      for(let i=0;i<120&&!globalThis.__CONCORD_VERDICT__;i++)await new Promise(r=>setTimeout(r,100));
      const honest = globalThis.__CONCORD_VERDICT__;
      const r = structuredClone(globalThis.__CONCORD_RECEIPT__);
      const i = r.entries.findIndex(e=>e.statement.result?.minor!==undefined);
      if(i>=0) r.entries[i].statement.result.minor = 1; else r.entries[0].statement.step="nothing";
      await globalThis.__CONCORD_CHECK__(JSON.stringify(r), "tampered");
      const forged = globalThis.__CONCORD_VERDICT__;
      const coordinator = new URL(document.getElementById("coordLink").href).origin;
      const entries = globalThis.__CONCORD_RECEIPT__?.entries?.length ?? 0;
      $("verdict").textContent =
        (honest.ok && !forged.ok && entries >= 3 && !honest.reached.includes(coordinator)
          ? "RECEIPT PASSED" : "RECEIPT FAILED")
        + ` honest=${honest.ok} tampered=${forged.ok} statements=${entries}`
        + ` asked-coordinator=${honest.reached.includes(coordinator)}`;})()' \
  node tools/shot.mjs 2>/dev/null | head -1 | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).head||"NO ANSWER"))'
fi

echo ""
echo "── an interrupted commitment, found and resolved ──"
# The claim this whole design is for: kill the coordinator holding real effects,
# come back, and everything that can be put back is. It needs two browser runs
# in one profile, because a journal survives a reload and not a new profile --
# which is also why it had never been checked end to end, and why two
# participant bugs lived in here until the screen was built to show them.
PROF="$(mktemp -d)"
trap 'kill $SERVER 2>/dev/null || true; rm -rf "$PROF"' EXIT

PROFILE="$PROF" URL=http://localhost:5173/concord.html OUT=/dev/null SETTLE=6000 \
  DO='(async()=>{const $=id=>document.getElementById(id);
      $("q").value="Book me London for three nights — flight, hotel and the visa fee.";
      $("ask").requestSubmit();
      for(let i=0;i<200&&$("commit").hidden;i++)await new Promise(r=>setTimeout(r,100));
      $("crash").click();})()' \
  node tools/shot.mjs >/dev/null 2>&1 || true

printf '  %-24s ' "crash and recover"
PROFILE="$PROF" URL=http://localhost:5173/concord.html OUT=/dev/null SETTLE=12000 \
  DO='(async()=>{const $=id=>document.getElementById(id);
      for(let i=0;i<80&&!$("resolve");i++)await new Promise(r=>setTimeout(r,100));
      if(!$("resolve")){$("verdict").textContent="RECOVERY FAILED nothing outstanding was found";return;}
      const rows=[...document.querySelectorAll(".recovery tbody tr")].length;
      $("resolve").click();
      await new Promise(r=>setTimeout(r,7000));
      const answers=[...document.querySelectorAll(".recovery .answer")].map(a=>a.textContent);
      const clean=document.querySelector(".recovery").classList.contains("done");
      $("verdict").textContent = (clean && rows>0 && answers.every(a=>/undone|never happened/.test(a))
        ? "RECOVERY PASSED" : "RECOVERY FAILED") + ` ${rows} outstanding · ${answers.join(" ; ")}`;})()' \
  node tools/shot.mjs 2>/dev/null | head -1 | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).head||"NO ANSWER"))'

echo ""
echo "── ring0, the substrate ──────────────────────────"
for page in index.html phase02.html phase03.html phase04.html; do
  printf '  %-24s ' "ring0/$page"
  verdict "http://localhost:5173/ring0/$page"
done

echo ""
echo "── the live deployment ───────────────────────────"
node deploy/verify-live.mjs 2>&1 | tail -1
