// Groups incoming messages per chat and hands them to `flush` once per task
// (setTimeout 0), so a burst of N arrivals costs one flush instead of N.
// `epoch` (account epoch at the first push) travels with the batch; pushes
// carrying a different epoch start a fresh batch and drop the stale one.
export function createNotifyQueue(flush, schedule = fn => setTimeout(fn, 0)) {
  let groups = null;
  let epoch;
  return {
    push(msg, msgEpoch) {
      const chatId = msg?.chatId ?? null;
      if (groups && epoch !== msgEpoch) groups = null;
      if (!groups) {
        groups = new Map();
        epoch = msgEpoch;
        const mine = groups;
        schedule(() => {
          if (groups !== mine) return;
          groups = null;
          Promise.resolve(flush(mine, msgEpoch)).catch(err => console.warn("notify flush failed:", err));
        });
      }
      const list = groups.get(chatId);
      if (list) list.push(msg); else groups.set(chatId, [msg]);
    },
    get pending() { return groups ? groups.size : 0; },
  };
}
