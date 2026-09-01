// Stable serialisation, following RFC 8785 (JSON Canonicalization Scheme).
//
// Key order must never change a digest, or two honest parties hash the same
// fact differently and every proof built on it fails. That matters more here
// than in most places: the pitch is that no partnership is required, so a
// verifier nobody has met has to reach the same bytes from the same JSON.
//
// The first version diverged from JSON in two ways that a third-party
// implementation would not reproduce. A member whose value was `undefined`
// serialised as null where JSON omits it, and objects carrying a toJSON method
// -- a Date, most obviously -- serialised as `{}` instead of their JSON form.
// Both are fixed below.
//
// Ordering was already right, contrary to a report that it needed code-point
// sorting: RFC 8785 section 3.2.3 sorts property names as arrays of UTF-16 code
// units, which is what the default string comparator does.

const JSONABLE = new Set(['string', 'number', 'boolean']);

export function canonical(value) {
  // toJSON first, so a Date canonicalises the way JSON.stringify writes it.
  if (value !== null && typeof value?.toJSON === 'function') return canonical(value.toJSON());

  if (value === null) return 'null';

  if (typeof value === 'number') {
    // JCS has no representation for these; JSON.stringify quietly writes null,
    // which would let two parties sign different meanings of the same bytes.
    if (!Number.isFinite(value)) throw new TypeError(`${value} cannot be canonicalised`);
    return JSON.stringify(value);
  }

  if (JSONABLE.has(typeof value)) return JSON.stringify(value);

  if (Array.isArray(value)) {
    // JSON writes a hole or an undefined element as null, and so does this.
    return `[${value.map((v) => (v === undefined || typeof v === 'function' || typeof v === 'symbol')
      ? 'null' : canonical(v)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const parts = [];
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      // Members JSON omits are omitted, rather than becoming null.
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      parts.push(`${JSON.stringify(k)}:${canonical(v)}`);
    }
    return `{${parts.join(',')}}`;
  }

  throw new TypeError(`${typeof value} cannot be canonicalised`);
}

export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => new Uint8Array(s.match(/../g).map((b) => parseInt(b, 16)));

export async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
