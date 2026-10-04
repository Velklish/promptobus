// Which reviewer result answers a review round: the next unseen one from the sender, and it
// names the round's diff file. A marker echo would test the model, not the diff it was given.
import path from 'node:path';

export function messageKey(message) {
  return String(message?.id ?? `${message?.ts ?? ''}:${message?.type ?? ''}:${message?.body ?? ''}`);
}

export function unseenResult(messages, seen, sender = () => true) {
  return (messages ?? []).find((message) => message?.type === 'result'
    && sender(message) && !seen.has(messageKey(message))) ?? null;
}

export function reportMentionsDiff(body, diffPath) {
  const name = path.basename(String(diffPath ?? ''));
  return !!name && String(body ?? '').includes(name);
}
