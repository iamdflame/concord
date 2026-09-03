# The post — two versions, because they are not the same post

You were right, and the rule is stricter than I had it. Verified for 2026:

| In a **promoted** post | |
|---|---|
| `@mentions` | **Banned** beyond your own handle. No `@OpenAIDevs`. |
| `#hashtags` | **Banned.** |
| External links | Not banned, but **penalised**. X's "beautiful ads" scheme gives *lower rates* to ads with no external links and no emoji, and its policy says the offer must be clear without needing a click. |
| Emoji | More than one lowers your quality score and **raises your price**. |

So the ad copy has zero mentions, zero hashtags, zero links and zero emoji — not
to be safe, but because on a $9 budget the pricing discount is a meaningful share
of the buy.

**The links problem solves itself:** the last frame of your video is the end card
with all four URLs on it. The ad does not need a link in the copy, because the
creative already carries them.

---

# 1. The promoted ad copy

Paste this into the ad. **1,538 characters** — needs X Premium on the posting
account. Checked: no `@`, no `#`, no URL, no emoji, no unusual glyphs.

```
Concord — an agent that cannot overpromise.

WebMCP tells an agent what a site can do. Nothing tells it what a site can take back.

So an agent booking your flight on one site and your hotel on another cannot know, before it starts, whether failing halfway leaves you holding a charge nobody can reverse. That gap is why a marketplace sits in the middle of nearly every transaction, taking 15-30% for the guarantee.

Concord replaces it with a convention. Any site declares what it can undo: reservable (hold it, release it, nothing happened), compensable (undoable, but it leaves a mark), or irreversible (it cannot be taken back).

A coordinator running in your own browser computes the strongest honest promise across every site involved before contacting any of them, and refuses when the honest answer is that no promise is available at any price.

The part worth checking yourself: the tool that spends money does not exist until a person accepts the exact guarantee they were shown. Not disabled. Not registered. registerTool puts it on the surface when a human clicks; an AbortController takes it away the instant the commitment starts. There is no tool that grants that permission, and there will not be one.

Every commitment ends in a receipt where each statement is signed by the counterparty that made it, with keys fetched from that vendor's own origin. The coordinator cannot forge it and cannot misreport it.

8 origins. 0 backends in the commitment path. MIT, zero dependencies.

Links are on the last frame of the video.
```

### Second ad for the same ad group — 245 characters, no Premium needed

X's campaign health is asking for a second creative so it can test them. Same
video, this copy. Also clean of mentions, hashtags, links and emoji.

```
Concord: the tool that spends your money does not exist until a person clicks accept.

Not disabled. Not registered. registerTool puts it on the surface when a human clicks; an AbortController removes it.

Built on WebMCP. 8 origins, 0 backends.
```

---

# 2. The organic post — different rules, so a different post

Post this from your account **as a normal tweet**, not through the ad manager.
Here mentions and links are fine and useful, and this is the one that can be
quoted, replied to and shared.

**1,894 characters, needs Premium.**

```
Concord — an agent that cannot overpromise.

WebMCP tells an agent what a site can do. Nothing tells it what a site can take back.

So an agent booking your flight on one site and your hotel on another has no way to know, before it starts, whether failing halfway leaves you holding a charge nobody can reverse. Today that gap gets filled by a marketplace both businesses have a contract with — which is why one sits in the middle of nearly every transaction, taking 15–30% for the guarantee.

Concord replaces it with a convention. Any site declares what it can undo:

reservable — hold it, release it, nothing happened
compensable — undoable, but it leaves a mark
irreversible — it cannot be taken back

A coordinator running in your own browser computes the strongest honest promise across every site involved BEFORE contacting any of them — and refuses when the honest answer is that no promise is available at any price.

The part worth checking yourself: the tool that spends money does not exist until a person accepts the exact guarantee they were shown. Not disabled — not registered. registerTool() puts concord_commit on the surface when a human clicks. An AbortController takes it away the instant the commitment starts. There is no tool that grants that permission, and there will not be one.

Every commitment ends in a receipt where each statement is signed by the counterparty that made it, with keys fetched from that vendor's own origin. Verify one somewhere I don't run — or npx concord-verify receipt.json, and nothing of mine executes.

8 origins. 0 backends in the commitment path. MIT, zero dependencies.

Live, nothing to install:
https://concord-coordinator.vercel.app/judge.html

Fire 14 forged receipts at my own verifier:
https://concord-coordinator.vercel.app/attack.html

Code:
https://github.com/iamdflame/concord

Built for the WebMCP Challenge @OpenAIDevs
```

### If you don't have Premium — 259 characters, then links in the first reply

```
Concord: an agent that structurally cannot overpromise.

The tool that spends your money doesn't exist until a person clicks accept. Not disabled — not registered. registerTool() puts it there, an AbortController takes it away.

WebMCP. 8 origins. 0 backends.
```

```
Live, nothing to install:
https://concord-coordinator.vercel.app/judge.html

Fire 14 forged receipts at my own verifier:
https://concord-coordinator.vercel.app/attack.html

MIT, zero dependencies:
https://github.com/iamdflame/concord

Built for the WebMCP Challenge @OpenAIDevs
```

---

# 3. The campaign form

## What $9 actually buys

At roughly $6 CPM, **$9 is about 1,500 impressions.** Your targeting currently
shows **494.7m–564.0m** people. Spreading 1,500 impressions across half a billion
is indistinguishable from not running the ad.

The most important thing on this form is therefore not the budget. It is
**narrowing the audience to the low millions** so those 1,500 impressions land
somewhere that matters. Everything below serves that.

And plainly, because you want this to reach the judges: **judging happens on your
Devpost entry, not on X.** Judges score four criteria against what you submitted;
an ad cannot reach them in that capacity and I will not pretend it can. What $9
is genuinely good for is what comes after — the OpenAI Devs spotlight, people who
work on WebMCP seeing that someone built a commitment layer on it, and anyone who
might use or extend the convention.

## Ad group

| Field | Set it to | Why |
|---|---|---|
| **Name** | `Concord — WebMCP, dev audience` | "Ad group 1" tells you nothing in a week. |
| **Daily budget** | `3.00` | Keep. |
| **Total spend cap** | `9.00` | Keep. Three days at $3. |
| **Start time** | leave `Sep 3, 2026, 2:18 PM GMT+1` | Fine. Note the hackathon deadline is 1:00pm PDT = **9:00pm GMT+1**, so this starts 6.7 hours before it. |
| **End time** | Run indefinitely | The $9 cap stops it anyway. |

## Demographics

| Field | Set it to |
|---|---|
| **Locations** | United States, United Kingdom, Canada, Germany, Netherlands, India. Going harder by city: San Francisco, New York, Seattle, London. |
| **Languages** | English. Just the one. |
| **Gender** | All. Narrowing buys nothing here. |
| **Age** | 25–54, or leave All. |
| **Operating system** | All — do not set it. People read X on a phone and open the link later. |
| **Device model / Carrier** | Leave empty. |
| **Custom audiences** | Leave empty — you have no list. |

## Delivery & placements

| Field | Set it to | Why |
|---|---|---|
| **Optimization goal** | **Video views** — keep | You want the film watched, and the film ends on the URLs. Coherent with link-free copy. |
| **Pay by** | **Impressions (CPM)** — keep | |
| **Bid strategy** | **Automatically maximize at lowest price** | Correct for a $9 test. Do not set a manual bid; you have no data to set one from. |
| **Placements** | Open **Advanced** and turn **off** X Audience Platform / off-network placements if enabled. Keep Home timeline and Profiles. | Off-network inventory is where a small budget dies. |

## Advanced targeting — the part that matters

Empty right now, which is why the estimate reads 494.7m. Fill all three and watch
it collapse.

**Keywords**

```
WebMCP
Model Context Protocol
MCP servers
AI agents
agentic commerce
browser agents
tool calling
function calling
Chrome origin trial
```

**Follower look-alikes** — *targeting* these is allowed and is not the same thing
as @mentioning them in copy. Verify each handle exists before adding it.

```
OpenAIDevs
OpenAI
ChromiumDev
vercel
Cloudflare
```

**Interests**

```
Technology → Software development
Technology → Artificial intelligence
Technology → Web development
Business → Startups
```

**Check the estimate after each addition.** Above ~20m, add keywords rather than
locations. Below ~500k, remove one — too narrow and X cannot spend the budget.

## The creative

- **Attach the 1:56 video natively.** Upload the MP4; do not link YouTube.
- **Alt text:** *"A browser tool inspector showing five registered tools;
  concord_commit appears only after a person clicks Accept."*
- **Captions.** It autoplays muted and most people never unmute. Upload an SRT if
  the cut has no burned-in captions.
- **Do not add a website card with a link** unless you switch the objective to
  Website traffic. With Video views, link-free copy is both compliant and cheaper,
  and the end card already shows the URLs.

---

## After it is live

**Reply to every technical reply yourself.** Conversation is weighted far above
likes, and the people worth reaching are the sceptical ones. Your best material is
in the objections — "a vendor can lie about being compensable" has a real answer.

**Don't delete and repost** on a quiet first hour; you lose the engagement
history. Post the second variant as its own tweet a day later.

**Watch replies, not impressions.** At $9 the impression count will look
disappointing whatever you do. One reply from someone who works on WebMCP is
worth more than the whole dashboard.
