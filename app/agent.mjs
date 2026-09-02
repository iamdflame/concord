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
export async function makeReader() {
  try {
    const LM = globalThis.LanguageModel ?? globalThis.ai?.languageModel;
    if (LM && (await LM.availability?.()) !== 'unavailable') {
      const session = await LM.create({
        initialPrompts: [{ role: 'system', content:
          'You choose which vendors a travel request needs. Reply with only a JSON array of ids '
          + 'from the list you are given, no prose.' }],
      });
      return {
        kind: "Chrome's built-in model",
        async read(text, vendors) {
          const reply = await session.prompt(
            `Vendors: ${JSON.stringify(vendors.map((v) => ({ id: v.id, title: v.title })))}\n`
            + `Request: ${text}\nWhich ids are needed?`);
          const ids = JSON.parse(reply.match(/\[[\s\S]*\]/)?.[0] ?? '[]');
          return { ids: ids.filter((id) => vendors.some((v) => v.id === id)), reversibleOnly: REVERSIBLE_ONLY.test(text) };
        },
      };
    }
  } catch { /* fall through to reading it here */ }

  return {
    kind: 'a local intent reader (this browser has no built-in model)',
    async read(text, vendors) {
      const ids = VENDOR_WORDS.filter((v) => v.words.test(text))
        .map((v) => v.id)
        .filter((id) => vendors.some((v) => v.id === id));
      return { ids, reversibleOnly: REVERSIBLE_ONLY.test(text) };
    },
  };
}

/**
 * One turn: intent in, a commitment or an honest refusal out.
 *
 * `say` writes to the transcript, `tool` calls a published Concord tool, and
 * `confirm` puts the decision back to the human before anything is committed.
 */
export async function turn({ text, reader, tool, say, confirm }) {
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

  const out = await tool('concord_commit', { proposalId: proposal.proposalId });
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
