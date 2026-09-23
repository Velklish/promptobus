# Closed task journal

One line per task: number with slug, closing date, outcome, closing commit, and title. The body is not in the tree — the definition and the result live in git, and `npx github:Velklish/backslop#v0.10.0 show N` retrieves them. Lines follow the order of closing.

An `—` outcome means that `result.md` did not name one. An `—` commit means that the body went into the message of the folding commit, and `show` looks it up by the `PB-N:` subject.
