# The X post

## Read this first — your video will be rejected as an ad

**Promoted videos on X cap at 2:20. Your demo is 2:45.** Standard promoted video
is capped at 2 minutes 20 seconds; going longer needs an extension requested
through an X account manager, which is a thing large advertisers do for movie
trailers, not something you will get before a deadline.

Two separate things, then:

| | Organic post | Promoted (ads.x.com) |
|---|---|---|
| Video | the full 2:45 cut | a **new cut, ≤2:20** — and 15–30s performs best |
| Hashtags | optional | **banned.** X does not allow hashtags on promoted posts |
| Link | fine | fine, and needed as the destination |

The honest recommendation: **promote a 30–45 second cut, not the whole film.**
Native video on X gets far more engagement than a link out, 15–30s is the
best-performing length, and the first 3 seconds decide everything. The full 2:45
belongs on the organic post and on the Devpost entry, where someone has already
chosen to pay attention.

I can spec that short cut from the existing shot list — say the word and you get
exact in/out timecodes from clips you have already recorded. Nothing to re-film.

---

## The post

### Recommended — the mechanism

This is the one. It leads with the single most distinctive thing about the
project, it is precise enough that a Chrome or OpenAI engineer will recognise it
as a real claim rather than marketing, and the first line survives being cut off
by "Show more".

**259 characters — fits without X Premium.**

```
The tool that spends your money does not exist until you click accept.

Not disabled. Not registered.

registerTool() puts it on the surface when a human clicks. An AbortController takes it away. There is no tool that grants that permission.

Built on WebMCP.
```

**Why this one.** Every other entry will say what their agent *can* do. This says
what the platform makes *impossible*, in the API's own vocabulary. "Not disabled.
Not registered." is the whole idea in four words, and it is the line most likely
to get quoted by someone else — which is the reach you cannot buy.

---

### Alternate — the refusal (use if you want the product angle, not the API angle)

**240 characters.**

```
I built an agent that says no.

Ask it to book a flight and two non-refundable fees. It refuses — before contacting anyone — because no honest guarantee exists across them.

There is no button on that answer.

WebMCP. 8 origins. 0 backends.
```

---

### Alternate — the forgery (highest curiosity, lowest explanation)

**236 characters.** Strong hook, and it works because it opens by admitting a
failure, which almost nothing in a hackathon feed does.

```
We shipped a receipt verifier, then spent a day forging receipts against it.

7 of 14 got through.

They don't any more. The fix: derive the outcome from the signatures instead of believing the field nobody signs.

Fire all 14 yourself:
```

---

## The thread (post these as replies to your own post, immediately)

Threads hold attention and give the algorithm more to work with. Post all of them
within a minute or two of the first.

**1/**
```
The problem: WebMCP tells an agent what a site can DO. Nothing tells it what a site can TAKE BACK.

So an agent booking a flight on one site and a hotel on another cannot know, before it starts, whether failing halfway leaves you with a charge nobody can reverse.
```

**2/**
```
Concord lets any site declare a commitment surface:

reservable — hold it, release it, nothing happened
compensable — undoable, but it leaves a mark
irreversible — it cannot be taken back

Then it computes the strongest honest promise across sites BEFORE contacting any of them.
```

**3/**
```
Two irreversible steps in one plan? No honest guarantee exists, so it refuses — and nothing was contacted.

The refusal is the part I haven't seen elsewhere. An agent that can decline to promise, for a reason computed from declarations rather than from a policy someone wrote.
```

**4/**
```
Every commitment produces a receipt where each statement is signed by the counterparty that made it, with keys fetched from that vendor's own origin.

Check one on an origin I don't run, or:

npx concord-verify receipt.json

Nothing of mine executes.
```

**5/** — the links, last
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

## Reach — what actually helps, and what I will not promise

You asked that it reach OpenAI people and the judges. Here is the honest version:
**ads buy impressions, not specific people.** Nobody can guarantee a named
engineer sees a post. What you *can* do is make it overwhelmingly likely to land
in the right feeds, and make it good enough that it travels once it does.

**Tag exactly one account: `@OpenAIDevs`.** It is verified — the hackathon's own
prize description names it ("Spotlight on @OpenAIDevs Twitter"), so it is the
account that runs this challenge. One relevant mention reads as context. Five
reads as spam and gets muted.

**Do not tag people whose handles you have not personally checked.** WebMCP was
co-authored by engineers at Google (David Bokan, Khushal Sagar, Hannah Van
Opstal) and Microsoft (Brandon Walderman, Leo Lee, Andrew Nolan), through the W3C
Web Machine Learning Community Group, and MCP-B/WebMCP work is associated with
Alex Nahas. I could not verify current X handles for any of them and I am not
going to guess — tagging the wrong account is worse than tagging nobody, and it
is the kind of error that gets screenshotted.

**Targeting to set up on ads.x.com:**

- *Follower look-alikes* — `@OpenAIDevs`, `@OpenAI`, `@ChromiumDev`, `@vercel`,
  `@Cloudflare`. Verify each exists before adding it.
- *Keywords* — WebMCP, Model Context Protocol, MCP, AI agents, agentic commerce,
  browser agents, tool use, function calling.
- *Interests* — software development, AI/ML, web development.
- *Geography* — US and Western Europe skew, but do not over-narrow; engineers
  travel and the audience is small enough already.
- *Budget* — X ad engagement runs roughly $0.50–$2.00, with CPM far below
  LinkedIn's. A small budget goes a long way against a niche keyword set. Start
  low, look at which variant earns replies rather than impressions, then push
  budget into that one.

**Timing.** Post Tuesday–Thursday, 9–11am US Eastern. That is when this audience
is at a keyboard on both coasts and in Europe's afternoon.

---

## Details that are easy to skip and shouldn't be

**The video autoplays muted.** Your first card reads "An agent that cannot
overpromise." — that works silent, which is lucky. Whatever short cut you make,
check it makes sense with the sound off, because most people will never turn it
on.

**Add captions to the ad cut.** Captioned video measurably outperforms
uncaptioned on X, for the same reason.

**Alt text on the video.** Write: *"A browser tool inspector showing five
registered tools; concord_commit appears only after a person clicks Accept."*
Costs nothing, and it is read by people who will not watch.

**Reply to every technical reply.** The algorithm weights conversation heavily,
and the people worth reaching are the ones who ask a sceptical question. Answer
those properly — the project's best material is in the objections.

**Do not delete and repost** if it underperforms in the first hour. You lose the
engagement history. Post a second, different angle a day later instead; you have
three variants above.

---

## Before you post

1. **Cut the ≤2:20 ad version** (or ask me for exact timecodes).
2. **Confirm the YouTube video is Public**, not Unlisted — the same check the
   Devpost submission needs.
3. Check every link in reply **5/** opens.
4. Post the video **natively** to X. Do not post a YouTube link as the main
   creative and expect it to travel.
