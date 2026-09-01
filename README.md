# Ring 0

A capability kernel for the agentic web.

WebMCP lets a page hand structured tools to an AI agent. It also ships a taint
bit (`untrustedContentHint`) and an effect bit (`readOnlyHint`) and enforces
neither, and Chrome's own security guidance assigns indirect prompt injection to
the developer. Ring 0 is the layer that acts on those bits: it treats every
origin as a process and every tool as a syscall, then schedules, labels, and
records the calls between them.

**Status: Phase 01 complete — interception proven.** The kernel can stand
between an agent and another origin's tools. Nothing else is built yet.

## Run it

```bash
npm run dev     # two origins: kernel :5173, workload :5174
npm run probe   # the Phase 01 suite in headless Chrome
```

`DEBUG_WIRE=1 npm run probe` adds the cross-frame message trace.

## What Phase 01 proves

Two interception modes have to hold or the architecture is wrong.

| | Mechanism | Why it matters |
|---|---|---|
| **Mode A** — kernel as agent | The kernel discovers with `getTools({fromOrigins})` and dispatches with `executeTool()`. | Every call crosses the kernel by construction. |
| **Mode B** — kernel as shim | The kernel registers a *proxy* tool; `execute()` runs policy, then forwards. | An external agent we do not control — ChatGPT's browser, Gemini in Chrome — sees only mediated tools. |

| | Assertion |
|---|---|
| A1 | A model context is available, and the suite reports which implementation |
| A2 | The workload registers tools and the kernel observes `toolchange` |
| A3 | `getTools({fromOrigins})` returns a tool granted via `exposedTo` |
| A4 | **Mode A** — the kernel executes the cross-origin tool directly |
| A5 | A tool with no `exposedTo` grant is invisible to another origin |
| A6 | Executing an ungranted tool is *refused with a reason*, not merely hidden |
| A7 | The kernel registers a proxy tool an external agent can discover |
| A8 | **Mode B** — the proxy forwards, and the kernel observed the call |

A5 and A6 are the pair that matters. Hiding a tool from discovery is not access
control, so A6 forges a descriptor pointing straight at the withheld tool and
requires an explicit denial — a timeout fails that assertion even though it also
blocked the call. Granting `exposedTo` to the withheld tool turns both red,
which is how we know the suite has teeth.

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
kernel/             origin A :5173 — Ring 0, and the Phase 01 suite
workload/           origin B :5174 — a supervised process; one tool granted, one withheld
shim/webmcp.mjs     spec-faithful WebMCP for browsers that lack it
shim/adapter.mjs    native-first resolution; reports which provider you got
tools/probe.mjs     headless Chrome over CDP
```

## Next

Phase 02 replaces the single line in the proxy's `execute()` with the taint
lattice and the policy gate.

MIT.
