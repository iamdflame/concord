// Property-based testing, in about a hundred lines and no dependencies.
//
// This project has no dependencies on purpose, and reaching for fast-check to
// gain property tests would trade a stated value for a convenience. What is
// actually needed is small: deterministic generators, a loop, and a shrinker
// that reports the smallest failing case rather than the first one found.
//
// Deterministic on purpose. A property suite that fails once a fortnight on a
// seed nobody wrote down is worse than no property suite, so every run reports
// its seed and any failure can be replayed with SEED=<n>.

/** xorshift32. Small, fast, and the same everywhere. */
export function rng(seed) {
  let x = seed | 0 || 0x2f6e2b1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

export const int = (lo, hi) => (r) => lo + Math.floor(r() * (hi - lo + 1));
export const pick = (...xs) => (r) => xs[Math.floor(r() * xs.length)];
export const bool = () => (r) => r() < 0.5;

export const array = (gen, { min = 0, max = 8 } = {}) => (r) => {
  const n = min + Math.floor(r() * (max - min + 1));
  return Array.from({ length: n }, () => gen(r));
};

export const record = (shape) => (r) =>
  Object.fromEntries(Object.entries(shape).map(([k, g]) => [k, g(r)]));

/** Any JSON value, including the awkward ones. */
export const json = (depth = 3) => (r) => {
  const leaf = () => pick(
    0, 1, -1, 1.5, -0.0, 1e21, Number.MIN_SAFE_INTEGER,
    '', 'a', 'quoted"inside', '\\', ' ', 'üñî', '🙂',
    true, false, null,
  )(r);
  if (depth <= 0 || r() < 0.45) return leaf();
  if (r() < 0.5) return array(json(depth - 1), { max: 4 })(r);
  const keys = ['a', 'b', 'Z', 'à', '', '0', 'k'];
  const n = Math.floor(r() * 4);
  const out = {};
  for (let i = 0; i < n; i++) out[keys[Math.floor(r() * keys.length)]] = json(depth - 1)(r);
  return out;
};

/**
 * Shrink a failing case towards something a person can read.
 *
 * Structural and deliberately dumb: drop an array element, drop an object key,
 * move a number towards zero, shorten a string. It is not minimal and does not
 * try to be. It is the difference between "failed on a nine-element array of
 * objects" and "failed on [0]", which is the whole value.
 */
function* shrinks(value) {
  if (Array.isArray(value)) {
    if (value.length) yield value.slice(0, -1);
    if (value.length > 1) yield value.slice(1);
    for (let i = 0; i < value.length; i++) {
      for (const s of shrinks(value[i])) yield value.map((v, j) => (i === j ? s : v));
    }
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const { [k]: dropped, ...rest } = value;
      void dropped;
      yield rest;
    }
    for (const k of Object.keys(value)) {
      for (const s of shrinks(value[k])) yield { ...value, [k]: s };
    }
  } else if (typeof value === 'number' && value !== 0) {
    yield 0;
    if (Number.isInteger(value) && Math.abs(value) > 1) yield Math.trunc(value / 2);
  } else if (typeof value === 'string' && value.length) {
    yield value.slice(0, -1);
  }
}

/**
 * Run the property once.
 *
 * A note for anyone writing one: the shrinker is structural, so it will hand a
 * property inputs the generator would never have produced -- it drops object
 * keys and array elements on the way to something small. Properties must
 * therefore be total. One that throws a TypeError on a shrunk input reports
 * its own arithmetic instead of the defect it found.
 */
async function check(value, holds) {
  try {
    const out = await holds(value);
    if (out === true || out === undefined) return null;
    return typeof out === 'string' ? out : `returned ${JSON.stringify(out)}`;
  } catch (err) {
    return err.message;
  }
}

/**
 * Check that a property holds over many generated inputs.
 *
 * `holds` returns true or undefined to pass, and either throws or returns a
 * string explaining the failure. Async properties are supported because half
 * of this codebase is.
 */
export async function forAll(gen, holds, { runs = 200, seed } = {}) {
  const used = seed ?? (Number(process.env.SEED) || 1);
  const r = rng(used);

  for (let i = 0; i < runs; i++) {
    const value = gen(r);
    const why = await check(value, holds);
    if (!why) continue;

    // Found one. Now make it small enough to read.
    let best = value, bestWhy = why;
    for (let pass = 0; pass < 200; pass++) {
      let improved = false;
      for (const candidate of shrinks(best)) {
        const w = await check(candidate, holds);
        if (w) { best = candidate; bestWhy = w; improved = true; break; }
      }
      if (!improved) break;
    }
    throw Object.assign(
      new Error(`property failed after ${i + 1} cases (replay with SEED=${used})\n`
        + `  smallest failing input: ${JSON.stringify(best)}\n  ${bestWhy}`),
      { counterexample: best, seed: used });
  }
  return { runs, seed: used };
}
