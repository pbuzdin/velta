// media-catchup.js — #478's background placeholder drain. With a download
// limit set, oversized attachments arrive as tap-to-download placeholders;
// this queue fetches them AFTER the text is in, newest chat first (the chat
// the user has open jumps the queue), one at a time so the foreground IMAP
// path never competes with a fan-out. A scan reads the newest page of every
// chat — placeholders concentrate there; deep history drains on later runs.
// Reruns are debounced and coalesced: a trigger during a run marks one rerun
// that fires when the run finishes, so bursts of events cost one rescan.
export const BETWEEN_ITEMS_MS = 250;
export const MAX_ITEMS_PER_RUN = 300;

export function createMediaCatchup({
  core,
  getChatIds,
  getCurrentChatId = () => null,
  limitOn = () => true,
  betweenMs = BETWEEN_ITEMS_MS,
} = {}) {
  let token = 0;
  let running = false;
  let rerun = false;
  let timer = null;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const pending = (m) => m.downloadState && m.downloadState !== "Done" && m.downloadState !== "InProgress";

  async function scan(id, budget) {
    const { messages } = await core.getMessages(id, { limit: 40 });
    for (const m of messages || []) {
      if (!pending(m)) continue;
      if (budget.n >= MAX_ITEMS_PER_RUN) return;
      budget.n++;
      await core.downloadFullMessage(m.id);
      if (betweenMs > 0) await sleep(betweenMs);
    }
  }

  async function run() {
    if (running) { rerun = true; return; }
    running = true;
    rerun = false;
    const my = ++token;
    try {
      if (!limitOn()) return;
      const ids = await getChatIds();
      const cur = getCurrentChatId();
      const ordered = cur != null && ids.includes(cur) ? [cur, ...ids.filter(i => i !== cur)] : ids;
      const budget = { n: 0 };
      for (const id of ordered) {
        if (my !== token || rerun || budget.n >= MAX_ITEMS_PER_RUN) return;
        await scan(id, budget);
      }
    } catch { /* a failed scan retries on the next trigger */ }
    finally {
      running = false;
      if (rerun) schedule();
    }
  }

  function schedule(delayMs = 5000) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; run(); }, delayMs);
  }

  return { schedule, now: () => schedule(0) };
}
