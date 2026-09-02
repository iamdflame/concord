// The palette, checked against the page rather than against a copy of it.
//
// Colour that carries meaning is not decoration, and "it looked fine on my
// monitor" is not a measurement. Every token below is read out of
// concord.html's own token blocks and put through the WCAG contrast formula
// against the grounds it is actually painted on, in both themes. Changing a
// token to something unreadable fails here, which is the only reason the
// separation between the ramp (3px edges, free to carry chroma) and the ink
// (13px words, not free) stays true after the day it was introduced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./concord.html', import.meta.url), 'utf8');

/** OKLCH -> linear sRGB. The conversion in the CSS Color 4 spec, verbatim. */
function toLinearRGB(L, C, H) {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
}

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(fg, bg) {
  const a = luminance(toLinearRGB(...fg));
  const b = luminance(toLinearRGB(...bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Every `--name: oklch(L% C H)` in a slice of the stylesheet. */
function declared(block) {
  const out = new Map();
  for (const m of block.matchAll(
    /--([a-z0-9-]+)\s*:\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/g)) {
    if (!out.has(m[1])) out.set(m[1], [Number(m[2]) / 100, Number(m[3]), Number(m[4])]);
  }
  return out;
}

const at = (needle) => {
  const i = css.indexOf(needle);
  assert.ok(i >= 0, `could not find ${needle} in the stylesheet`);
  return i;
};

const LIGHT = declared(css.slice(at(':root{'), at('@media (prefers-color-scheme: dark)')));
const MEDIA = declared(css.slice(at('@media (prefers-color-scheme: dark)'), at(':root[data-theme="dark"]')));
const TOGGLE = declared(css.slice(at(':root[data-theme="dark"]'), at('*{box-sizing')));

/**
 * Resolve a token the way the cascade does.
 *
 * The dark palette only overrides what differs, so anything it leaves alone --
 * the three ramp colours, deliberately -- still has to be measured against the
 * dark grounds. Reading only the dark block would silently skip exactly the
 * tokens most likely to be wrong there.
 */
function tokens(scope) {
  return (name) => {
    const base = LIGHT.get(name);
    assert.ok(base, `--${name} is not declared in the light palette`);
    if (scope === 'light') return base;
    return MEDIA.get(name) ?? base;
  };
}

test('the two dark palettes agree', () => {
  // Dark is declared twice on purpose: once under prefers-color-scheme for the
  // browser's own setting, once under [data-theme] so the toggle wins in both
  // directions. A token in one and not the other is a theme that changes when
  // you touch the switch.
  assert.deepEqual([...MEDIA.keys()].sort(), [...TOGGLE.keys()].sort(),
    'the media query and the [data-theme] override do not name the same tokens');
  for (const [name, value] of MEDIA) {
    assert.deepEqual(TOGGLE.get(name), value, `--${name} differs between the two dark blocks`);
  }
});

// Foreground, ground, minimum ratio, and where it is painted. Large text is
// held to 3:1 per WCAG; everything else to 4.5:1.
const PAIRS = [
  ['ink',              'paper',      4.5, 'body text'],
  ['ink-2',            'paper',      4.5, 'the lead paragraph and the caveats'],
  ['ink-3',            'paper',      4.5, 'marginalia labels, table heads, the step column'],
  ['ink-3',            'paper-sunk', 4.5, 'receipt metadata'],
  ['ink-2',            'paper-sunk', 4.5, 'receipt prose and the composer input'],
  ['irreversible-ink', 'paper',      4.5, '"not taken back" and the point-of-no-return note'],
  ['compensable-ink',  'paper',      4.5, 'a countervailing ledger entry'],
  ['reservable-ink',   'paper',      4.5, 'the "Nothing stands" outcome'],
  ['refusal',          'paper',      3.0, 'the refusal headline (large)'],
  ['fail',             'paper-sunk', 4.5, 'a broken seal'],
  ['seal',             'paper-sunk', 4.5, 'a sealed entry, and VERIFIED'],
];

for (const scope of ['light', 'dark']) {
  test(`every colour that carries meaning is legible in ${scope}`, () => {
    const t = tokens(scope);
    for (const [fg, bg, need, where] of PAIRS) {
      const ratio = contrast(t(fg), t(bg));
      assert.ok(ratio >= need,
        `--${fg} on --${bg} is ${ratio.toFixed(2)}:1, below ${need}:1 — ${where}`);
    }
  });
}

test('the ramp and the ink are separate tokens', () => {
  // The point of the split: an edge is allowed to be a colour that words are
  // not. If someone collapses them back together, the ink follows the edge and
  // the contrast test above starts failing for reasons nobody will connect to
  // this. Better to say it here.
  const dark = tokens('dark');
  const light = tokens('light');
  for (const rung of ['reservable', 'compensable', 'irreversible']) {
    assert.notDeepEqual(dark(rung), dark(`${rung}-ink`),
      `--${rung} and --${rung}-ink are the same colour in dark; the split has been undone`);
  }
  // In light the edge is already dark enough that irreversible may legitimately
  // coincide, so only the two that must differ are asserted.
  for (const rung of ['reservable', 'compensable']) {
    assert.notDeepEqual(light(rung), light(`${rung}-ink`),
      `--${rung} and --${rung}-ink are the same colour in light`);
  }
});
