// The second door onto the same accept.
//
// WebMCP's draft has modelContext.requestUserInteraction(): a way for a tool to
// tell the browser that a person needs to look at the page, so the agent's host
// can surface it rather than leaving a prompt sitting behind a tab nobody is
// watching. Chrome 151 does not implement it -- app/native.html measures that
// rather than assuming it -- and until this file existed, Concord only reported
// its absence.
//
// So it is used now, and the shape of the use is the point.
//
//   It asks for attention. It does not grant anything.
//
// The permission primitive is unchanged and stays unchanged: concord_commit is
// registered by registerTool when a person clicks accept, and by nothing else.
// This never calls accept(), never touches the surface, and its failure changes
// no outcome -- a browser without it behaves exactly as before, which is the
// entire reason it is safe to feature-detect rather than depend on.
//
// If it were on the permission path, an agent that could call it could talk the
// host into producing consent, and the claim this project makes would be false.
// Both doors lead to the same room; only one of them is a lock.

/** Is the platform affordance here? Measured once, reported honestly. */
export const canRequestAttention = (mc) =>
  typeof mc?.requestUserInteraction === 'function';

/**
 * Ask the host to bring the person to the page, if it can.
 *
 * Returns what actually happened, so the agent can be told the truth: an agent
 * that believes a person has been notified when nobody has will wait forever,
 * and one that says "I have asked them to look" when the browser cannot do that
 * is overpromising -- the specific failure this whole project is about.
 */
export async function askForAttention(mc, { reason } = {}) {
  if (!canRequestAttention(mc)) {
    return { asked: false, why: 'this browser does not implement requestUserInteraction' };
  }
  try {
    await mc.requestUserInteraction({ reason });
    return { asked: true, why: 'the host was asked to bring the person to the page' };
  } catch (err) {
    // A host may refuse: the tab is already focused, the user has muted this
    // page, the call arrived without a user gesture behind it. None of that is
    // an error in the commitment, and none of it may change what is registered.
    return { asked: false, why: `the host declined: ${err.message}` };
  }
}
