// The taint lattice.
//
// Labels form a lattice ordered by set inclusion: more labels means more
// restricted, and join is union. A value derived from labelled inputs carries
// at least their join. That part is standard information-flow control.
//
// The part that is not standard, and that this file is honest about, is that an
// agent's reasoning is opaque. We cannot follow a string through a language
// model the way a taint tracker follows a register through a CPU. So the kernel
// tracks two different things and never conflates them:
//
//   UNTRUSTED         evidence-backed. The argument the agent produced actually
//                     contains content that arrived from an untrusted source.
//                     A direct flow we can point at.
//
//   TAINTED_CONTEXT   the sound floor. Untrusted content entered this session
//                     at all, so any later argument *might* derive from it,
//                     even laundered through paraphrase. Cannot be evidenced,
//                     cannot be ruled out.
//
// Policy treats them differently: direct flow is denied outright, possible flow
// asks a human. That is the whole safety claim, stated precisely -- containment
// at the effect boundary, not immunity inside the model.

export const UNTRUSTED = 'UNTRUSTED';
export const TAINTED_CONTEXT = 'TAINTED_CONTEXT';
export const USER = 'USER';
export const originTag = (o) => `origin:${o}`;

export class Label {
  #tags;
  constructor(tags = []) { this.#tags = Object.freeze([...new Set(tags)].sort()); }
  static empty = new Label();
  static of(...tags) { return new Label(tags); }

  get tags() { return this.#tags; }
  has(tag) { return this.#tags.includes(tag); }
  join(other) { return new Label([...this.#tags, ...other.tags]); }
  /** this ⊑ other — every restriction here is also carried there. */
  flowsTo(other) { return this.#tags.every((t) => other.has(t)); }
  toString() { return this.#tags.length ? `{${this.#tags.join(', ')}}` : '{}'; }
}

const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'this', 'that', 'with', 'from',
                      'have', 'has', 'was', 'are', 'please', 'all', 'any', 'our']);

/**
 * Whether a lone word is strong enough to be evidence by itself.
 *
 * This threshold matters more than it looks. An earlier version indexed every
 * word, and a legitimate payment carrying the memo "invoice 4471" was denied --
 * because the attacker's message also said "invoice" and "4471". A gate that
 * refuses honest work is not a safe gate, it is a broken one, and users route
 * around it. So a single word counts only if it is identifier-shaped: long,
 * and carrying an underscore, an at-sign, or mixed letters and digits. Ordinary
 * vocabulary earns nothing on its own and must appear in a phrase to matter.
 */
const isDistinctive = (w) => w.length >= 8 && (/[_@]/.test(w) || (/[a-z]/.test(w) && /\d/.test(w)));

/** Content signature: identifier-shaped tokens, plus word 4-grams for phrase reuse. */
function signature(text) {
  // Dots and hyphens belong inside a token (no-reply@notices.example) but not
  // at its edges. Without this trim, "acct_supplier." in prose never matches
  // "acct_supplier" in an argument -- a mutation test caught the honest payment
  // passing by accident rather than by corroboration, which is the worse of the
  // two failures because it looks like success.
  const words = (String(text).toLowerCase().match(/[a-z0-9_@.-]{3,}/g) ?? [])
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length >= 3);
  const sig = new Set();
  for (const w of words) if (isDistinctive(w)) sig.add(w);
  for (let i = 0; i + 4 <= words.length; i++) {
    const gram = words.slice(i, i + 4);
    if (gram.some((w) => !STOP.has(w))) sig.add(gram.join(' '));
  }
  return sig;
}

/** Walks a value yielding every string with the argument path that holds it. */
function* strings(value, path = '', depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') yield { path: path || '.', text: value };
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`, depth + 1);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* strings(v, path ? `${path}.${k}` : k, depth + 1);
  }
}

export class Provenance {
  #context = Label.empty;                 // sound floor for the session
  #untrusted = new Map();                 // signature token -> where it came from
  #corroborated = new Map();              // signature token -> which origin asserts it
  #log = [];

  /** Record what a tool returned, at the label the boundary assigned it. */
  observe(value, label, source) {
    this.#context = this.#context.join(label);
    const sink = label.has(UNTRUSTED) ? this.#untrusted : this.#corroborated;
    for (const { text } of strings(value)) {
      for (const token of signature(text)) {
        if (!sink.has(token)) sink.set(token, source);
      }
    }
    this.#log.push({ label: String(label), source });
  }

  /**
   * Label an argument the agent produced. Evidence of direct reuse outranks the
   * session floor, because it is the difference between "this call was written
   * by the attacker" and "this call happened after the attacker spoke".
   */
  labelFor(args) {
    const evidence = [];
    for (const { path, text } of strings(args)) {
      for (const token of signature(text)) {
        const source = this.#untrusted.get(token);
        if (!source) continue;
        // Corroboration declassifies. An invoice arrives by email, so the
        // legitimate payee account is untrusted content too -- refusing it
        // would block the honest payment for the same reason as the attack.
        // What separates them is whether an independent origin that is not a
        // taint source asserts the same value. The ledger names the supplier's
        // settlement account; nothing but the forged notice names the
        // attacker's. That difference is the whole judgement, and it is a
        // property of the composition rather than of the text.
        const corroborator = this.#corroborated.get(token);
        if (corroborator) continue;
        evidence.push({ field: path, token, source });
      }
    }

    if (evidence.length) {
      // Rank by specificity: a 4-gram is far stronger evidence than one word.
      evidence.sort((a, b) => b.token.length - a.token.length);
      return {
        label: this.#context.join(Label.of(UNTRUSTED)),
        evidence: evidence.slice(0, 3),
      };
    }
    // No traceable reuse. The session floor still applies -- laundering through
    // the model leaves no evidence, and silence is not proof of cleanliness.
    const floor = this.#context.has(UNTRUSTED) || this.#context.has(TAINTED_CONTEXT)
      ? this.#context.join(Label.of(TAINTED_CONTEXT))
      : this.#context;
    return { label: new Label(floor.tags.filter((t) => t !== UNTRUSTED)), evidence: [] };
  }

  /** Which independent origin, if any, also asserts this value. */
  corroborationFor(token) { return this.#corroborated.get(String(token).toLowerCase()) ?? null; }

  get context() { return this.#context; }
  get history() { return [...this.#log]; }
}
