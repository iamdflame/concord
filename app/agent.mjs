// The agent.
//
// It has no privileged access to anything. It drives the same four WebMCP tools
// Concord publishes to any agent, which means the constraint it operates under
// is not a matter of how it was written or prompted -- it is the shape of what
// it can reach. Replace it with ChatGPT and nothing about the safety story
// changes, which is the point.
//
// The loop is deliberately the one a careful person would follow: find out what
// is here, work out what could be promised, say that out loud, wait to be told
// to go ahead, then report what actually stands rather than what was asked for.

const VENDOR_WORDS = [
  { id: 'fly',    words: /\b(flight|fly|flights|air|airline|seat|plane)\b/i },
  { id: 'stay',   words: /\b(hotel|room|stay|night|nights|accommodation|lodging)\b/i },
  { id: 'visa',   words: /\b(visa|consular|entry fee|travel fee)\b/i },
  { id: 'permit', words: /\b(permit|entry permit)\b/i },
  { id: 'shady',  words: /\b(meridian|allocation|holdings)\b/i },
  { id: 'lounge', words: /\b(lounge|skyline|pass)\b/i },
];

const REVERSIBLE_ONLY = /\b(refundable|reversible|can'?t take back|cannot take back|nothing irreversible|no.{0,12}non-?refundable|back out)\b/i;

/**
 * Read an intent into a set of vendors.
 *
 * Chrome's built-in model is used when the browser has one; otherwise this
 * reads the request directly. Which brain is in use is stated in the transcript
 * rather than implied, because a demo that quietly degrades is a demo that
 * lies about what it is.
 */
/**
 * Reading a request without a model. Always available, and the fallback.
 *
 * It matches on what each participant calls itself before it consults the
 * synonyms, which matters because a participant's id is whatever it declared --
 * not whatever the coordinator files it under. A site written in the sandbox
 * thirty seconds ago names itself, and asking for it by that name has to work
 * without anyone editing this file.
 */
function localReader(kind) {
  return {
    kind,
    async read(text, vendors) {
      const words = new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []));
      const named = vendors.filter((v) =>
        words.has(String(v.id).toLowerCase())
        || String(v.title ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 3)
             .some((w) => words.has(w)));

      const bySynonym = VENDOR_WORDS.filter((w) => w.words.test(text)).map((w) => w.id);
      const ids = [...new Set([
        ...named.map((v) => v.id),
        // Synonyms resolve against the id a participant declares, and are
        // dropped when nothing here answers to that name.
        ...bySynonym.filter((id) => vendors.some((v) => v.id === id)),
      ])];
      return { ids, reversibleOnly: REVERSIBLE_ONLY.test(text) };
    },
  };
}

export async function makeReader({ onFallback } = {}) {
  const local = localReader('a local intent reader (this browser has no built-in model)');
  let session = null;

  try {
    const LM = globalThis.LanguageModel ?? globalThis.ai?.languageModel;
    if (LM && (await LM.availability?.()) !== 'unavailable') {
      session = await LM.create({
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: [{ role: 'system', content:
          'You choose which vendors a travel request needs. Reply with only a JSON array of ids '
          + 'from the list you are given, no prose.' }],
      });
    }
  } catch { session = null; }

  if (!session) return local;

  // Present is not the same as usable. Chrome can report a built-in model and
  // then answer "there was not an execution config available for the feature",
  // which arrives when the request is made rather than when the session is
  // created. Committing to it at startup and discovering that mid-conversation
  // is how a demo dies in front of somebody, so a failure at use falls back for
  // good and says which brain is now answering.
  let usable = true;
  return {
    get kind() {
      return usable ? "Chrome's built-in model"
        : 'a local intent reader (the built-in model would not run)';
    },
    async read(text, vendors) {
      if (usable) {
        try {
          const reply = await session.prompt(
            `Vendors: ${JSON.stringify(vendors.map((v) => ({ id: v.id, title: v.title })))}\n`
            + `Request: ${text}\nWhich ids are needed?`);
          const ids = JSON.parse(reply.match(/\[[\s\S]*\]/)?.[0] ?? '[]');
          const chosen = ids.filter((id) => vendors.some((v) => v.id === id));
          // An empty answer is not an answer; read it here instead.
          if (chosen.length) return { ids: chosen, reversibleOnly: REVERSIBLE_ONLY.test(text) };
          usable = false;
        } catch {
          usable = false;
        }
        onFallback?.();
      }
      return local.read(text, vendors);
    },
  };
}

/**
 * One turn: intent in, a commitment or an honest refusal out.
 *
 * `say` writes to the transcript, `tool` calls a published Concord tool, and
 * `confirm` puts the decision back to the human before anything is committed.
 */
export async function turn({ text, reader, tool, say, confirm, refuse }) {
  const vendors = await tool('concord_list_vendors', {});
  const { ids, reversibleOnly } = await reader.read(text, vendors);

  if (!ids.length) {
    say('agent', 'I could not tell which of these vendors that needs. There is a flight, a hotel '
      + 'and a consular fee here — try naming one.');
    return null;
  }

  let chosen = ids;
  if (reversibleOnly) {
    const irreversible = vendors.filter((v) => !v.steps.includes('cancel') && !v.steps.includes('compensate'));
    const dropped = irreversible.filter((v) => ids.includes(v.id));
    chosen = ids.filter((id) => !dropped.some((v) => v.id === id));
    if (dropped.length) {
      say('agent', `You said nothing you cannot take back, so I have left out `
        + `${dropped.map((v) => v.title).join(' and ')} — ${dropped.length === 1 ? 'it declares' : 'they declare'} `
        + `no way to reverse ${dropped.length === 1 ? 'itself' : 'themselves'}.`);
    }
    if (!chosen.length) { say('agent', 'That leaves nothing to commit to.'); return null; }
  }

  const proposal = await tool('concord_propose_commitment', { intent: text, vendors: chosen });
  if (proposal.refused) { say('agent', proposal.reason); return null; }

  // The refusal case, which is the one an agent normally cannot express.
  if (!proposal.committable) {
    const why = await tool('concord_explain_guarantee', { proposalId: proposal.proposalId });
    // The refusal is the answer, so it is shown where an answer is shown --
    // not only narrated in the transcript while the panel keeps whatever it
    // last said, which reads as if nothing happened.
    refuse?.(why);
    say('agent', `I cannot do that as one commitment, and I would rather say so than half-do it.\n\n`
      + `${why.summary.replace(/^Cannot be done as one commitment\.\s*/, '')}\n\n`
      + `Nothing has been contacted. Ask for them separately and I will do each one.`);
    return null;
  }

  const promise = await tool('concord_explain_guarantee', { proposalId: proposal.proposalId });
  say('agent', [
    `Here is what I can promise before I touch anything.`,
    '',
    promise.summary,
    '',
    `Order: ${promise.order.join(' → ')}.`,
    promise.pointOfNoReturn ? `Past ${promise.pointOfNoReturn} there is no going back.` : null,
    ...promise.caveats.map((c) => `· ${c}`),
    promise.recoverable ? null
      : '· If this is interrupted mid-call, one of these cannot be asked afterwards what happened.',
  ].filter(Boolean).join('\n'), { promise });

  const go = await confirm(promise);
  if (!go) { say('agent', 'Left alone. Nothing was contacted.'); return null; }

  // The digest of the guarantee, carried through. The agent is naming the
  // promises it read out, not just the proposal it read them from -- and if
  // the person accepted something else, this is refused rather than committed.
  const out = await tool('concord_commit',
    { proposalId: proposal.proposalId, digest: promise.explanationDigest });
  if (out.refused) { say('agent', out.reason); return null; }

  // Name businesses the way they name themselves. "shady declared it could
  // reverse this" reads as an internal id leaking, and this sentence is an
  // accusation -- it should carry the name the vendor trades under.
  const named = Object.fromEntries(vendors.map((v) => [v.id, v.title ?? v.id]));
  const name = (id) => named[id] ?? id;

  // Report what stands, never what was asked for.
  const lines = {
    committed: `Done. ${out.stands.map(name).join(', ')} — settled together.`,
    unwound: `Nothing stands. ${out.cause}\nEverything reversible was reversed; you have not been charged.`,
    'in-doubt': [
      'This did not finish cleanly, and I will not pretend otherwise.',
      '',
      ...(out.broken?.length
        // The honest limit of the design, said out loud. Nothing can stop a
        // vendor declaring a reversal it will not honour; what the receipt does
        // is put a name and a signature on it.
        ? [...out.broken.map((f) => `${name(f.id)} declared it could reverse this and then would `
            + `not: "${f.error}". It still holds what it took.`),
           '',
           'Its own signature is on the statement saying it took it, so this is a documented '
           + 'breach rather than a disagreement about what happened.']
        : []),
      ...(out.stranded ?? [out.cause].filter(Boolean)),
    ].join('\n'),
    refused: out.cause ?? 'Refused.',
  };
  say('agent', lines[out.outcome] ?? `Outcome: ${out.outcome}`, { result: out });
  return out;
}
