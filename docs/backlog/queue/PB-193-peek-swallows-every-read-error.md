# PB-193 · peekInbox skips a message it cannot read, and its comment names only the one refusal that is harmless

- **Order:** 130
- **Scope:** `src/v1/messages.ts` (`peekInbox`), the `BrokenNote` channel it already carries
- **Created:** 2026-09-12, acceptance of run 0912c
- **Dependencies:** none

## What happens

`peekInbox` walks the inbox and reads each file. The read is wrapped like this
(`src/v1/messages.ts:649`):

```ts
try {
  raw = readFileSync(file, 'utf8');
} catch {
  // The owner took it between the listing and the read: they will deliver the message.
  continue;
}
```

The comment names **one** refusal, and for that one the behaviour is right: the file vanished
between the listing and the read because its owner claimed it, and the owner will deliver it. That is
`ENOENT`, and skipping it is correct.

The `catch` takes **every** refusal. `EACCES`, `EPERM`, `EIO`, a directory where a file was expected,
a full or unmounted volume — each one is skipped with the same silence, and the caller is told the
inbox holds one message fewer. Nothing distinguishes "somebody else already has this message" from
"this message exists and I cannot read it".

## Why the difference is not academic

The function **already has a channel for exactly this**: it builds `broken: BrokenNote[]` and uses it
for a record that does not parse or does not validate. A file that cannot be read is the same kind of
fact — the message is there and unusable — and it is the only such fact that goes nowhere.

Run 0912c made the case concrete rather than hypothetical. Its participants hit read and write
refusals repeatedly and with system codes: `listen EPERM` on a socket, `EPERM` on `live.sock`,
`PermissionError: [Errno 1] Operation not permitted` on an ordinary write into a participant's own
worktree (`PB-191`). In an environment that refuses reads, a peek that silently drops what it cannot
read reports **"no mail"** where the truth is **"cannot read the mail"** — and the participant waits
for a message that was in front of it.

## What to do

- Split the two cases at the read. `ENOENT` keeps today's behaviour and the comment that explains it.
  Every other refusal becomes a `BrokenNote` with its code, so the caller is told the inbox holds a
  message it could not open.
- Decide and write down what `peek` **returns** when a message is unreadable: it must not be counted
  as absent. Whether it counts as present-but-broken or as an error of the peek itself is the
  decision this card asks for.
- Mutation probe on both halves: make a file unreadable and show the red naming it; make a file
  disappear between listing and read and show that this case stays green. One probe reddening both
  means the split was not made.

## Out of scope

- The parse and validate branches below the read: they already classify and already produce notes.
- `PB-134`, which shares the read→parse→validate→isolate loop across three callers. That card
  preserves the three existing error policies deliberately and says so; this card is about whether
  one of those policies is right, which is a different question and must not be smuggled into a
  deduplication.
