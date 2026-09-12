# PB-200 · The exemption's token boundary is narrower than the detector's, so a longer path on an exempt prefix escapes

- **Order:** 65
- **Scope:** `scripts/audit-public.mjs`
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Found by review, immediately after the owner-home rule landed. Two prior holes in the same rule were
closed in that round — the whole-file exemption and the extension allowlist — and this is what the
fix left behind.

The detector and the exemption use **two different grammars for where a path token ends**. A tilde is
accepted inside a child path by the detector, but it is not a path character for the code that strips
an exempt literal. So a text that begins with an allowed prefix and continues with `~` has the
prefix removed and yields **no finding**, though the remaining text is exactly the shape the rule
exists to catch. One such string is live in a session fixture today.

The claim the card and the tests make — «a longer path built on an exempt prefix is still a finding»
— therefore does not hold for that one punctuation case. The rule is not inert; it is *narrower than
it states*, which is the same defect class the two earlier holes belonged to: a guard whose message
is broader than its reach.

## Work to do

- Give detection and stripping **one** token-boundary grammar, or exempt the exact source snippets
  together with their delimiters. Two grammars over the same text will drift again.
- Add a same-prefix punctuation regression: the exempt literal followed by a character the detector
  accepts must still be reported.

## Out of scope

- The set of exempt fixtures and the reasons they are exempt; that decision stands.
- Content-based text classification and the checked-entry counts — both landed and are verified.

## Verification

- A red check on the shape: exempt literal + one accepted-but-unstripped character → finding, named.
- A mutation probe aimed at the shared grammar rather than at the fixture list: widening one side's
  character set alone must redden that verdict. A green probe here condemns the check.
- `npm run audit` exit 0 with the checked-entry count stated.
