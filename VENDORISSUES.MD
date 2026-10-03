
### 10. The SMTP loop's bound transport is not exposed to clients (#79)

**Status: patched locally (`core/src/smtp.rs` + `core/src/scheduler.rs` +
`core/src/scheduler/connectivity.rs` — all blocks carry the `Velta patch
(#79)` marker; re-apply on every core upgrade).**

The SMTP loop tries every configured transport on (re)connect (newest first)
and uses whichever connects, but `configured_addr` is only re-elected when a
transport is REMOVED — and nothing tells clients which transport actually
won. UIs that mark "the sending relay" (Velta's envelope) key off
`configured_addr` and lie during failover. Upstream direction: selection is
"moving to the authority of the SMTP loop" (chatmail/core#8619).

Patch: `Smtp` carries a shared `sending_transport: Arc<AtomicU32>` set on
connect success and cleared in `disconnect()`; `SmtpConnectionState` clones
the handle out of the loop-owned connection; `get_connectivity_html` emits
`<span class="smtp-via">{addr}</span>` in the Outgoing-messages `<li>` when
a transport is bound. Velta's `parseConnectivityHtml` reads it and keys the
envelope/dashes to it (`relaySmtpVia`), falling back to `configured_addr`
for unpatched cores. Upstream fix: expose the bound transport properly
(e.g. an RPC or event per chatmail/core#8619) — then drop this patch.
