// Own-reaction toggle. Delta Chat core keeps one reaction set per sender and
// send_reaction(msgId, list) REPLACES it: [] removes ours, [e] replaces it.
// Velta sends at most one emoji, like the official clients.

export function myReaction(reactions) {
  return (reactions || []).find(r => r && r.mine)?.emoji || null;
}

// Tapping the emoji we already sent removes it; any other emoji replaces it.
// Returns the list to send and the optimistic chip list (null when empty).
export function reactionToggle(reactions, emoji) {
  const list = (reactions || []).map(r => ({ ...r }));
  const mine = list.find(r => r.mine);
  const removing = !!mine && mine.emoji === emoji;
  let next = list;
  if (mine) {
    mine.mine = false;
    mine.count = (Number(mine.count) || 1) - 1;
    next = next.filter(r => r.count > 0);
  }
  if (!removing) {
    const hit = next.find(r => r.emoji === emoji);
    if (hit) { hit.count = (Number(hit.count) || 0) + 1; hit.mine = true; }
    else next.push({ emoji, count: 1, mine: true });
  }
  return { send: removing ? [] : [emoji], removing, reactions: next.length ? next : null };
}
