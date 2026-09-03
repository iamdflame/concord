# The X post, and the campaign

## Correction first

I told you the video was 2:45 and that X would reject it as an ad. **That was
wrong.** I took the number from `demo/timing.mjs`, which measures the *planned*
edit in `demo/RECORDING.md` — not the film you actually cut. Yours is **1:56**,
which is comfortably inside X's 2:20 promoted-video limit.

**So: attach the full video. No short cut needed.** I have also corrected
`SUBMISSION.md`, which was claiming 2:45 next to the YouTube link.

The two things from that research that *do* still hold:

- **No hashtags on promoted posts.** X does not allow them. None of the copy
  below has any.
- **Post the video natively to X.** Upload the file. Do not post a YouTube link
  and expect it to travel — native video is weighted far more heavily.

---

## The post

Long, and it names the project in the first three words. X truncates after a
couple of lines with a "Show more", so the opening line has to carry the hook on
its own — this one does, and the rest rewards the click.

**1,894 characters. This needs X Premium** (the free limit is 280). If you do not
have it, use the short version below instead; do not try to cram this one.

```
Concord — an agent that cannot overpromise.

WebMCP tells an agent what a site can do. Nothing tells it what a site can take back.

So an agent booking your flight on one site and your hotel on another has no way to know, before it starts, whether failing halfway leaves you holding a charge nobody can reverse. Today that gap gets filled by a marketplace both businesses have a contract with — which is why one sits in the middle of nearly every transaction, taking 15–30% for the guarantee.

Concord replaces it with a convention. Any site declares what it can undo:

▸ reservable — hold it, release it, nothing happened
▸ compensable — undoable, but it leaves a mark
▸ irreversible — it cannot be taken back

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

### If you don't have X Premium — 259 characters

```
Concord: an agent that structurally cannot overpromise.

The tool that spends your money doesn't exist until a person clicks accept. Not disabled — not registered. registerTool() puts it there, an AbortController takes it away.

WebMCP. 8 origins. 0 backends.
```

…then put the links in the first reply:

```
Live, nothing to install:
https://concord-coordinator.vercel.app/judge.html

Fire 14 forged receipts at my own verifier:
https://concord-coordinator.vercel.app/attack.html

MIT, zero dependencies:
https://github.com/iamdflame/concord

Built for the WebMCP Challenge @OpenAIDevs
```

### The second ad — X is asking you for it

Campaign health says *"Ad groups with two or more ads let X test creatives and
serve your best performer"*, and it is right. Make a second ad in the same ad
group, same video, this copy. **247 characters**, so it works with or without
Premium.

```
Meet Concord: the tool that spends your money does not exist until you click accept.

Not disabled — not registered. registerTool() puts it on the surface when a human clicks; an AbortController removes it.

Built on WebMCP. 8 origins, 0 backends.
```

Let both run. After a day, put the remaining budget behind whichever earns
*replies*, not whichever earns impressions.

---

# The campaign form, field by field

## Before you fill it in — what $9 actually buys

At roughly $6 CPM, **$9 is about 1,500 impressions.** That is not a typo. Your
current targeting shows an audience of **494.7m–564.0m**, and spreading 1,500
impressions across half a billion people is indistinguishable from not running
the ad at all.

So the single most important thing on this form is not the budget. It is
**narrowing the audience until it is small enough that 1,500 impressions
actually lands on the right feeds.** Aim for an estimate in the **low millions**,
not hundreds of millions. Everything below is in service of that.

And one honest thing, because you said you want this to reach the judges: **the
judging happens on your Devpost entry, not on X.** Judges score the four criteria
against what you submitted. An ad cannot put you in front of them in their
judging capacity, and I am not going to pretend otherwise. What the ad is
genuinely good for is the thing after — the @OpenAIDevs spotlight, people who
work on WebMCP seeing that someone built a commitment layer on it, and anyone who
might want to use or extend the convention. That is worth $9. Winning is worth
the submission being right, which it now is.

## Ad group

| Field | Set it to | Why |
|---|---|---|
| **Name** | `Concord — WebMCP, dev audience` | "Ad group 1" tells you nothing in a week. |
| **Daily budget** | `3.00` | Keep it. |
| **Total spend cap** | `9.00` | Keep it. Three days at $3. |
| **Start time** | leave as `Sep 3, 2026, 2:18 PM GMT+1` | Fine. Note the hackathon deadline is 1:00pm PDT = **9:00pm GMT+1 today**, so this starts about six and a half hours before it. |
| **End time** | leave blank / Run indefinitely | The $9 cap stops it anyway. |

## Demographics

| Field | Set it to |
|---|---|
| **Locations** | **United States, United Kingdom, Canada, Germany, Netherlands, India.** If X lets you pick cities and you want to go harder: San Francisco, New York, Seattle, London. |
| **Languages** | **English.** One language. |
| **Gender** | **All.** Narrowing here excludes real audience and buys you nothing. |
| **Age** | **25–54.** Skips the segment least likely to be shipping production browser code. Leave "All" if you would rather not narrow twice. |
| **Operating system** | **All.** Do not set it. WebMCP is desktop Chrome, but people *read* X on a phone and open the link later. |
| **Device model** | leave empty |
| **Carrier** | leave empty |
| **Custom audiences** | leave empty — you have no list to upload |

## Delivery & placements

| Field | Set it to | Why |
|---|---|---|
| **Optimization goal** | **Video views** — keep it | You want the film watched. That is the asset. |
| **Pay by** | **Impressions (CPM)** — keep it | It is what the goal offers, and with automatic bidding you are not overpaying. |
| **Bid strategy** | **Automatically maximize results at the lowest price** | Correct for a $9 test. Do not set a manual max bid; you have no data to set it from. |
| **Placements** | Open **Advanced** and **turn off X Audience Platform / off-network placements** if they are on. Keep **Home timeline** and **Profiles**. | Off-network inventory is where a small budget goes to die. |

## Advanced targeting — this is the part that matters

This section is currently empty, which is why the estimate reads 494.7m. Fill in
all three and watch the number collapse.

**Keywords** — people who have posted or engaged with these:

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

**Follower look-alikes** — target people who follow accounts like these.
**Verify each handle exists before you add it**; a typo silently targets nobody
or, worse, somebody else:

```
@OpenAIDevs
@OpenAI
@ChromiumDev
@ChromeDevs
@vercel
@Cloudflare
@code
```

**Interests** — pick from X's list:

```
Technology → Software development
Technology → Artificial intelligence
Technology → Web development
Business → Startups
```

**Check the estimate after each addition.** If you are still above ~20m, add more
keywords rather than more locations. If you drop below ~500k, remove a keyword —
too narrow and X cannot deliver the budget at all.

## The creative

- **Attach the 1:56 video natively.** Upload the MP4; do not link YouTube.
- **Alt text on the video:** *"A browser tool inspector showing five registered
  tools; concord_commit appears only after a person clicks Accept."*
- **Captions.** The video autoplays muted and most people never unmute. If your
  cut has no burned-in captions, upload an SRT.
- **Destination URL:** `https://concord-coordinator.vercel.app/judge.html` — the
  five-minute path, not the root. It is the page built for someone arriving cold.

---

## After it is live

**Reply to every technical reply yourself.** The algorithm weights conversation
far above likes, and the people worth reaching are the ones who ask a sceptical
question. Your best material is in the objections — "a vendor can lie about being
compensable" has a real answer and it is a good one.

**Don't delete and repost** if the first hour is quiet. You lose the engagement
history. Post the second variant as its own tweet a day later instead.

**Watch replies, not impressions.** With $9 the impression count will look
disappointing no matter what. One reply from someone who works on WebMCP is worth
more than every number on that dashboard.
