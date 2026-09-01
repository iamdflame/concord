# Ring 0 capability policy.
#
# Read top to bottom. Every refusal in the interface quotes the rule that
# produced it, so this file is the explanation users actually see.

# ---------------------------------------------------------------------------
# Capabilities. WebMCP describes what a tool *is* -- readOnlyHint gives us
# effect, untrustedContentHint marks a taint source -- but says nothing about
# what a tool can reach. That gap is filled here and nowhere else.
# ---------------------------------------------------------------------------

capability tool:*/send_funds     egress funds
capability tool:*/post_message   egress network

# ---------------------------------------------------------------------------
# Containment by origin. Composition means three independent parties are in the
# same tab, so authority is pinned to the one that legitimately holds it. If the
# mail origin ever registers a tool called send_funds, it is denied on the
# strength of where it came from, before anything about its arguments matters.
# ---------------------------------------------------------------------------

deny tool:*/send_funds where origin != http://localhost:5176
     reason "only the payments origin may move funds"

# ---------------------------------------------------------------------------
# Reading is unrestricted. Nothing observable leaves the tab, so a read cannot
# be the step that harms anyone -- it can only be the step that taints what
# comes after, which is what the labels are for.
# ---------------------------------------------------------------------------

allow tool:* where effect == read

# ---------------------------------------------------------------------------
# Direct flow. The argument the agent produced measurably reuses content that
# arrived from an untrusted source. This is not a call the user asked for; it
# is a call the attacker wrote. There is no confirmation that makes it safe,
# because the user would be confirming the attacker's sentence.
# ---------------------------------------------------------------------------

deny tool:* where egress != none
     and labels includes UNTRUSTED
     reason "this call reuses content that arrived from an untrusted source"

# ---------------------------------------------------------------------------
# Possible flow. Untrusted content entered the session, and laundering through
# a language model leaves no evidence -- so we can neither prove nor rule out
# that this call derives from it. A human decides, having been told exactly
# what entered and when.
# ---------------------------------------------------------------------------

allow tool:* where egress != none
      and labels includes TAINTED_CONTEXT
      and confirm == human

# ---------------------------------------------------------------------------
# Clean, but consequential. Moving money is confirmed even in an untainted
# session. Nothing below this line grants an unclassified effectful tool, so
# anything not named above is denied by default rather than by omission.
# ---------------------------------------------------------------------------

allow tool:*/send_funds where egress == funds and confirm == human
