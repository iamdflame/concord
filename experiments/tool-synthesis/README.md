# Tool synthesis — an experiment whose answer was no

Concord asks vendors to declare a commitment protocol. The obvious objection is
that no site does that yet, so before building it I tested the alternative:
**can tools be synthesised for sites that never heard of WebMCP?**

The premise was better than it sounds. The web has been publishing
machine-readable capability declarations for over a decade and almost nothing
consumed them — schema.org `potentialAction`, OpenSearch descriptors, `<form>`
semantics, ARIA. So this is mostly reading declarations rather than guessing,
and every tool is scored by which tier it came from:

| tier | source | |
|---|---|---|
| 1 | schema.org `potentialAction` | the site declared this action |
| 2 | OpenSearch descriptor | the site declared this query interface |
| 3 | form with labelled controls | the site declared this shape |
| 4 | inferred from markup | we guessed |

```bash
node experiments/tool-synthesis/probe.mjs https://en.wikipedia.org/ https://arxiv.org/
```

## The result

Eleven real sites, none of them prepared. Anonymous public pages yield **search,
almost exclusively**. Three non-search capabilities turned up across all eleven,
and they were exactly the sites still built on real HTML forms — OpenStreetMap
routing with typed origin and destination, Wikipedia's edit form, gov.uk
feedback. GitHub, an enormously capable application, yielded `open_dialog` and
`copy_code_to_clipboard` and nothing else: its capability lives entirely in
click handlers with no declared shape.

That is structural, not a tuning problem. **Synthesis quality is inversely
correlated with how modern the app is.** The web has more capability than ever
and less declared surface than ever, and the trend runs against this approach.

Two other findings worth keeping. `potentialAction` does exist in the wild but
is rare — one hit in eleven sites. And login forms synthesise as tools, which is
worse than useless; anything shipping this needs to refuse them explicitly.

## Why it is still here

It is the reason Concord asks vendors to declare a protocol instead of inferring
one. A negative result that changed the design is worth more in the repository
than out of it — but it is not part of the product, which is why it lives here
and no script in `package.json` reaches it.
