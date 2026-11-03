// Core watchdog (#240): notices a core that stops answering RPCs and offers
// (or, when it truly died, performs) a restart. step() is a pure reducer —
// (state, input) -> { state, actions } — so the policy is unit-tested
// (tests/core-watchdog.test.mjs); startCoreWatchdog() is the thin driver
// that pings, reads rpc-core's in-flight table and executes the actions.

export const WATCHDOG = Object.freeze({
  PING_EVERY_MS: 5000,        // liveness ping cadence while the app is visible
  PING_STALL_MS: 8000,        // an unanswered ping this old = unresponsive
  RPC_STALL_MS: 10000,        // or the oldest in-flight RPC this old
  HUNG_RESTART_MS: 60000,     // a hang this long gets an automatic restart
  RESUME_GRACE_MS: 8000,      // after the app comes back to the foreground
  PING_TIMEOUT_MS: 60000,     // client-side settle of a ping; staleness is judged by age
  BACKOFF_MS: [1000, 5000, 30000], // automatic restart delays, by attempt
  MAX_RESTARTS: 3,            // automatic restarts allowed per window
  RESTART_WINDOW_MS: 600000,  // 10 min
});

// The liveness ping: get_system_info answers from build constants and never
// touches an account database, so only a wedged core/runtime delays it.
export const PING_METHOD = "get_system_info";

export function initialState(now = 0) {
  return {
    status: "healthy",  // healthy | stalled | dead | restarting | failed
    since: now,
    graceUntil: 0,
    restarts: [],       // timestamps of automatic restarts (cap window)
    nextRestartAt: 0,   // dead: when the next automatic try may run
    suppressedLogged: false,
    restartKind: "",    // "dead" | "hung" while restarting
  };
}

const sec = ms => `${Math.round(ms / 100) / 10}s`;
function describe(input) {
  const parts = [];
  if (input.pingPendingMs != null) parts.push(`ping ${sec(input.pingPendingMs)}`);
  const o = input.oldest;
  parts.push(o ? `oldest: ${o.method} ${sec(o.ms)}` : "oldest: none");
  return parts.join(", ");
}

function inWindow(restarts, now, W) {
  return restarts.filter(t => now - t < W.RESTART_WINDOW_MS);
}

function busyReason(busy) {
  if (busy?.transfer) return "backup/transfer running";
  if (busy?.call) return "call active";
  return "";
}

/**
 * input types:
 *  tick    { now, pingPendingMs, oldest: {method, ms}|null, busy: {transfer, call} }
 *  pong    { now, oldest }         a ping answered; oldest is the oldest unresolved RPC
 *  dead    { now, reason }         transport / worker / channel gone
 *  resume  { now }                 app back in the foreground
 *  restarted { now, ok, error }    outcome of a restart action
 *  manual  { now }                 user pressed "Restart core"
 * actions: {type:"log", msg} {type:"show", status} {type:"hide"}
 *          {type:"restart", kind, auto}
 */
export function step(state, input, W = WATCHDOG) {
  const s = { ...state, restarts: [...state.restarts] };
  const out = [];
  const log = msg => out.push({ type: "log", msg: "core watchdog: " + msg });
  const now = input.now;

  switch (input.type) {
    case "resume":
      s.graceUntil = now + W.RESUME_GRACE_MS;
      break;

    case "pong":
      // The ping avoids account DBs and scheduler locks, so it can answer
      // while the RPC that exposed the stall is still stuck.
      if (s.status === "stalled" && (input.oldest?.ms ?? 0) < W.RPC_STALL_MS) {
        log(`recovered after ${sec(now - s.since)}`);
        Object.assign(s, { status: "healthy", since: now, suppressedLogged: false });
        out.push({ type: "hide" });
      }
      break;

    case "dead":
      if (s.status === "dead" || s.status === "failed" || s.status === "restarting") break;
      s.restarts = inWindow(s.restarts, now, W);
      log(`core died (${input.reason || "unknown"})`);
      if (s.restarts.length >= W.MAX_RESTARTS) {
        log(`restart cap reached (${W.MAX_RESTARTS} in ${W.RESTART_WINDOW_MS / 60000} min) — giving up`);
        Object.assign(s, { status: "failed", since: now });
        out.push({ type: "show", status: "failed" });
      } else {
        const delay = W.BACKOFF_MS[Math.min(s.restarts.length, W.BACKOFF_MS.length - 1)];
        Object.assign(s, { status: "dead", since: now, nextRestartAt: now + delay, suppressedLogged: false });
        log(`restart #${s.restarts.length + 1} in ${sec(delay)}`);
        out.push({ type: "show", status: "dead" });
      }
      break;

    case "manual":
      if (s.status === "restarting") break;
      log(`manual restart requested (${s.status})`);
      Object.assign(s, { status: "restarting", restartKind: "manual" });
      out.push({ type: "restart", kind: "manual", auto: false });
      break;

    case "restarted":
      if (s.status !== "restarting") break;
      if (input.ok) {
        log(`restart (${s.restartKind}) done`);
        Object.assign(s, { status: "healthy", since: now, suppressedLogged: false, graceUntil: now + W.RESUME_GRACE_MS });
        out.push({ type: "hide" });
      } else {
        log(`restart (${s.restartKind}) failed: ${input.error || "unknown"}`);
        // A failed restart of a dead core counts as another death (backoff);
        // a hung/manual one goes back to "stalled" and the button stays.
        if (s.restartKind === "dead") {
          s.status = "restarting-failed";
          return mergeStep(s, out, { type: "dead", now, reason: "restart failed" }, W);
        }
        Object.assign(s, { status: "stalled", since: now, suppressedLogged: false });
        out.push({ type: "show", status: "stalled" });
      }
      break;

    case "tick": {
      const busy = busyReason(input.busy);
      if (s.status === "healthy") {
        if (now < s.graceUntil) break;
        const pingStuck = (input.pingPendingMs ?? 0) >= W.PING_STALL_MS;
        const rpcStuck = (input.oldest?.ms ?? 0) >= W.RPC_STALL_MS;
        if (pingStuck || rpcStuck) {
          // Date the stall from its start, so the 60 s hang clock is honest.
          const age = Math.max(input.pingPendingMs ?? 0, input.oldest?.ms ?? 0);
          Object.assign(s, { status: "stalled", since: now - age, suppressedLogged: false });
          log(`core unresponsive (${describe(input)})`);
          out.push({ type: "show", status: "stalled" });
        }
      } else if (s.status === "stalled") {
        if (now - s.since < W.HUNG_RESTART_MS) break;
        if (busy) {
          if (!s.suppressedLogged) log(`auto-restart suppressed: ${busy} (${describe(input)})`);
          s.suppressedLogged = true;
          break;
        }
        s.restarts = inWindow(s.restarts, now, W);
        if (s.restarts.length >= W.MAX_RESTARTS) {
          if (!s.suppressedLogged) log(`hung ${sec(now - s.since)}, restart cap reached — leaving it to the user`);
          s.suppressedLogged = true;
          break;
        }
        log(`hung ${sec(now - s.since)} — auto-restart (${describe(input)})`);
        s.restarts.push(now);
        Object.assign(s, { status: "restarting", restartKind: "hung" });
        out.push({ type: "restart", kind: "hung", auto: true });
      } else if (s.status === "dead") {
        if (now < s.nextRestartAt) break;
        if (busy) {
          if (!s.suppressedLogged) log(`auto-restart suppressed: ${busy}`);
          s.suppressedLogged = true;
          break;
        }
        log(`auto-restart #${s.restarts.length + 1} of dead core`);
        s.restarts.push(now);
        Object.assign(s, { status: "restarting", restartKind: "dead" });
        out.push({ type: "restart", kind: "dead", auto: true });
      }
      break;
    }
  }
  return { state: s, actions: out };
}

function mergeStep(s, out, input, W) {
  const r = step(s, input, W);
  return { state: r.state, actions: [...out, ...r.actions] };
}

/**
 * Driver. deps:
 *  core        JsonRpcCore (needs _callWithTimeout, oldestInFlight())
 *  isBusy()    -> { transfer, call }
 *  restart(kind) -> Promise (kind "dead" | "hung" | "manual")
 *  onShow(status) / onHide()
 *  log(msg)    velta.log + Diagnostics
 */
export function startCoreWatchdog({ core, isBusy, restarts = [], restart, onShow, onHide, log, W = WATCHDOG,
  doc = globalThis.document, setIntervalFn = setInterval, now = () => Date.now() }) {
  let state = { ...initialState(now()), restarts: [...restarts] };
  let pingStarted = 0; // 0 = no ping in flight
  const apply = input => {
    const r = step(state, input, W);
    state = r.state;
    for (const a of r.actions) {
      if (a.type === "log") log(a.msg);
      else if (a.type === "show") onShow(a.status);
      else if (a.type === "hide") onHide();
      else if (a.type === "restart") {
        Promise.resolve().then(() => restart(a.kind))
          .then(ok => apply({ type: "restarted", now: now(), ok: ok !== false }),
                e => apply({ type: "restarted", now: now(), ok: false, error: e?.message || String(e) }));
      }
    }
  };
  const visible = () => !doc || doc.visibilityState !== "hidden";
  const ping = () => {
    if (pingStarted) return;
    pingStarted = now();
    // Long client timeout: the watchdog judges by age, the call only needs
    // to settle eventually so the next ping can go out.
    core._callWithTimeout(W.PING_TIMEOUT_MS, PING_METHOD)
      .then(() => {
        pingStarted = 0;
        const t = now();
        apply({ type: "pong", now: t, oldest: core.oldestInFlight?.(t) || null });
      }, () => { pingStarted = 0; });
  };
  const tick = () => {
    if (!visible()) return;
    const t = now();
    apply({ type: "tick", now: t, pingPendingMs: pingStarted ? t - pingStarted : null,
      oldest: core.oldestInFlight?.(t) || null, busy: isBusy() });
    if (state.status === "healthy" || state.status === "stalled") ping();
  };
  doc?.addEventListener?.("visibilitychange", () => {
    if (visible()) { apply({ type: "resume", now: now() }); tick(); }
  });
  const timer = setIntervalFn(tick, W.PING_EVERY_MS);
  return {
    get state() { return state; },
    dead: reason => apply({ type: "dead", now: now(), reason }),
    manual: () => apply({ type: "manual", now: now() }),
    tick,
    stop: () => clearInterval(timer),
  };
}
