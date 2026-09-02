#!/usr/bin/env python3
"""Build the Concord marks.

The mark is a return path that cannot close. The ring is the round trip --
everything given back, everything as it was. The solid square is where that
stops, and it is the only part of the mark that is a different colour, because
it is the only part that means something the rest does not.

The wordmark is outlined from ui/fonts/serif-600.woff2, the same file the site
serves, so the name in the README and the headings on the pages are the same
shapes and no font has to be installed to see it.

    python3 -m venv .venv && .venv/bin/pip install fonttools brotli
    .venv/bin/python brand/build.py

The generated SVGs are committed. This script exists so their provenance is
checkable and so they can be rebuilt if the typeface or the palette changes --
not because anything needs to run it to use them.
"""

import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# ── geometry ───────────────────────────────────────────────────────────────
# A 64-unit square. The ring runs clockwise from 40 degrees and stops at 330,
# leaving seventy degrees open across the top. The square is centred on the
# ring at the stopping point, at more than twice the stroke width, so that it
# reads as a block rather than as a thickened end -- which is what happened at
# nine units, where it disappeared entirely below about thirty pixels.
CX = CY = 32.0
R = 19.5
STROKE = 5.5
START, END = 40.0, 330.0
SQUARE = 13.0


def point(deg):
    """A point on the ring, measured clockwise from twelve o'clock."""
    t = math.radians(deg)
    return CX + R * math.sin(t), CY - R * math.cos(t)


def arc(a, b):
    x1, y1 = point(a)
    x2, y2 = point(b)
    return f'M{x1:.2f} {y1:.2f}A{R} {R} 0 {1 if (b - a) % 360 > 180 else 0} 1 {x2:.2f} {y2:.2f}'


def square(size=SQUARE, deg=END):
    x, y = point(deg)
    return f'<rect x="{x - size / 2:.2f}" y="{y - size / 2:.2f}" width="{size}" height="{size}"'


# Where the ladder's three rungs fall on the ring, for the explanatory mark.
MID1 = START + (END - START) * 0.40
MID2 = START + (END - START) * 0.76

# ── palette ────────────────────────────────────────────────────────────────
# sRGB of the oklch tokens in ui/instrument.css. Written out because an SVG
# travels: a README on a service that does not resolve oklch would render the
# mark in whatever it fell back to.
LIGHT = {'ink': '#181e24', 'red': '#cf3100', 'blue': '#0072a8', 'green': '#187c49'}
DARK = {'ink': '#e9e8e2', 'red': '#dd5230', 'blue': '#008bc2', 'green': '#34925d'}

OPEN = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" '
        'width="64" height="64" fill="none" role="img"')


def write(name, body):
    with open(os.path.join(HERE, name), 'w') as fh:
        fh.write(body)
    print(f'  {name}')


def two_tone(c):
    return (f'  <path d="{arc(START, END)}" stroke="{c["ink"]}" stroke-width="{STROKE}"/>\n'
            f'  {square()} fill="{c["red"]}"/>')


def build_marks():
    write('concord-mark.svg', f'''<!-- Concord. A return path that cannot close.
     Monochrome: inherits currentColor, so it takes the colour of whatever it
     is set in. The square stays solid, because a mark whose only asymmetry is
     a gap is a mark with no asymmetry at small sizes. -->
{OPEN} aria-label="Concord">
  <title>Concord</title>
  <path d="{arc(START, END)}" stroke="currentColor" stroke-width="{STROKE}"/>
  {square()} fill="currentColor"/>
</svg>
''')

    for name, c in (('concord-mark-color.svg', LIGHT), ('concord-mark-dark.svg', DARK)):
        write(name, f'''<!-- The primary mark. One colour for the ring, one for the square: the
     square is the only part that means something the ring does not. -->
{OPEN} aria-label="Concord">
  <title>Concord</title>
{two_tone(c)}
</svg>
''')

    # The ladder, as a mark. Used where the palette is being explained rather
    # than where a logo is wanted -- three colours at logo size read as a
    # progress ring, which is the one thing this must not look like.
    write('concord-ladder.svg', f'''<!-- The commitment ladder drawn on the same ring: what can be released,
     what can be reversed, what cannot be undone, in the order the executor
     runs them. Explanatory, not a logo. -->
{OPEN} aria-label="The commitment ladder: reservable, compensable, irreversible">
  <title>The commitment ladder</title>
  <path d="{arc(START, MID1)}" stroke="{LIGHT['blue']}" stroke-width="{STROKE}"/>
  <path d="{arc(MID1, MID2)}" stroke="{LIGHT['green']}" stroke-width="{STROKE}"/>
  <path d="{arc(MID2, END)}" stroke="{LIGHT['red']}" stroke-width="{STROKE}"/>
  {square()} fill="{LIGHT['red']}"/>
</svg>
''')

    # A tab icon that reads on one background only is a tab icon half the
    # readers cannot find. Heavier stroke, because sixteen pixels is the size
    # this is actually used at.
    #
    # The light values are presentation attributes and the dark ones are the
    # CSS override, rather than both being CSS. A renderer that ignores <style>
    # then still draws a dark ring rather than an invisible one -- and note
    # that inside an <img>, this media query follows the operating system and
    # not the page it is embedded in, which is right for a browser tab and
    # misleading everywhere else. Use concord-mark-color.svg for pages.
    write('favicon.svg', f'''<!-- Follows the reader's system colour scheme, which is what a browser
     tab strip does. Do not use this in a document; use the mark. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" fill="none">
  <title>Concord</title>
  <style>
    @media (prefers-color-scheme: dark) {{
      .ring {{ stroke: {DARK['ink']} }} .stop {{ fill: {DARK['red']} }}
    }}
  </style>
  <path class="ring" d="{arc(START, END)}" stroke="{LIGHT['ink']}" stroke-width="7"/>
  {square(15)} class="stop" fill="{LIGHT['red']}"/>
</svg>
''')


# ── the wordmark ───────────────────────────────────────────────────────────
CAP = 34.0          # cap height of the type, against a 64-unit mark
GAP = 20.0          # space between mark and word
TRACK = {('C', 'o'): -8, ('n', 'c'): -4, ('c', 'o'): -6, ('o', 'r'): -4, ('r', 'd'): -14}


def wordmark_paths():
    """Glyph outlines for 'Concord', in a 100-unit cap-height coordinate space."""
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.misc.transform import Identity

    font = TTFont(os.path.join(ROOT, 'ui', 'fonts', 'serif-600.woff2'))
    upem = font['head'].unitsPerEm
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    scale = 100.0 / upem

    x, out, prev = 0.0, [], None
    for ch in 'Concord':
        name = cmap[ord(ch)]
        if prev is not None:
            # Source Serif ships GPOS kerning; this wordmark is seven letters
            # and reads better with the pairs adjusted by eye than with the
            # machinery to apply it.
            x += TRACK.get((prev, ch), 0) * scale
        pen = SVGPathPen(glyphs)
        # Font space is y-up, SVG is y-down.
        glyphs[name].draw(TransformPen(pen, Identity.translate(x, 100.0).scale(scale, -scale)))
        if pen.getCommands():
            out.append(pen.getCommands())
        x += font['hmtx'][name][0] * scale
        prev = ch
    return out, x


def build_lockups():
    paths, advance = wordmark_paths()
    k = CAP / 100.0
    width = 64.0 + GAP + advance * k
    glyphs = '\n      '.join(f'<path d="{d}"/>' for d in paths)

    for name, c in (('concord-lockup.svg', LIGHT), ('concord-lockup-dark.svg', DARK)):
        write(name, f'''<!-- Mark and wordmark. The wordmark is outlines taken from the same
     ui/fonts/serif-600.woff2 the site serves: nothing has to be installed to
     see it, and it cannot render as a substitute face. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.1f} 64"
     width="{width:.1f}" height="64" fill="none" role="img" aria-label="Concord">
  <title>Concord</title>
{two_tone(c)}
  <g transform="translate({64.0 + GAP:.2f} {32.0 - CAP / 2:.2f}) scale({k:.5f})" fill="{c['ink']}">
      {glyphs}
  </g>
</svg>
''')


if __name__ == '__main__':
    print('brand/')
    build_marks()
    build_lockups()
