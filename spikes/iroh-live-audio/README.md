# #472 spike: group audio over iroh-live

A standalone crate. It isn't part of any Velta app build and has its own `[workspace]` and `Cargo.lock`. It checks whether
[iroh-live](https://github.com/n0-computer/iroh-live) rooms (Media over QUIC
on iroh 1.x) can carry a small group voice call for Velta groups.

- iroh-live is pinned to git rev `747b1bd0`. It's MIT/Apache, not on crates.io,
  and pins `moq` by git rev, so it stays out of the app lockfiles for now.
- Relays are disabled, so no n0 infrastructure is used. In `bench`, peers find each other through
  in-memory address lookup. In `room`, they use mDNS on the LAN.
- Signaling over the group chat: `room` prints a `RoomTicket`
  (`room…` base32 string). Velta would post this, end-to-end encrypted, into the
  group chat as a message. Joining means parsing that string. No extra server is
  needed.
- Audio is 48 kHz mono Opus with 20 ms frames. The default build uses iroh-live's test tone and
  decode-only playback, so it runs headless. `--features devices` uses the
  real microphone and speakers (cpal, ALSA headers on Linux).

## Run

```sh
cargo build --release
./target/release/iroh-live-audio-spike bench --peers 3 --secs 10
./target/release/iroh-live-audio-spike room            # prints a ticket
./target/release/iroh-live-audio-spike room <ticket>   # 2nd process / machine
```

## Results (2026-11-23, 8 vCPU Xeon VM, all peers in one process, loopback)

| peers | streams up (in 30 s) | first audio | frames/s per stream | wire per peer (up = down) | CPU, whole process |
|---|---|---|---|---|---|
| 2 | 2/2 | 82–102 ms | 50.0 | 72 kbit/s | 8.9 % of one core |
| 3 | 6/6 | 82–507 ms | 50.0 | 133 kbit/s | 20 % |
| 4 | 6/12, then 12/12 at about 30 s | 82 ms – 30.2 s | about 50 | 175–225 kbit/s | 31–35 % |

The Opus target is 32 kbit/s. The wire per stream comes to about 36–37 kbit/s, which includes
QUIC, moq framing and gossip. Each peer sends a separate copy to each listener (mesh, no
SFU), so uplink grows as (N-1) × about 37 kbit/s.

`room` across two processes on one host via mDNS: the joiner saw the
creator's stream and decoded a steady 50 frames/s, in both directions.

## Findings / open problems

- **Works:** room join through a ticket, publishing, subscribing, Opus decode at full rate,
  and LAN-only operation with no relay.
- **Gotcha:** `PlayerConfig::default()` has `audio: AudioMode::Off`. Without
  `AudioMode::Decode` (or `Play`), subscriptions show up but no frames arrive.
- **4+ peers:** in both runs, half the streams took about 30 s to start, which looks like a
  subscribe or announce retry timeout in iroh-live or moq. Setup CPU also rose from 0.05 s
  to 6 s. This needs a look upstream before calls with more than 3 people.
- At exit, iroh-live logs `unauthorized` / `endpoint dropped` warnings while leaving. They do no harm, but
  a real integration should close rooms and endpoints in order.
- **Not done (later PRs):**
  - wiring into the Tauri app behind a feature flag;
  - posting and parsing the ticket in the group chat UI;
  - echo cancellation;
  - Android (cpal/Oboe);
  - the PWA (no iroh-live in the browser);
  - a relay path for NAT. We'd use our own iroh relay, never n0's.
