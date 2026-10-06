// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Velta contributors. Velta-original (clean-room, see
// docs/research/wasm-patches/velta-tokio-wasm-requirements.md).

//! Timers backed by the browser's `setTimeout` (through `wasmtimer`).

pub use std::time::Duration;
pub use wasmtimer::std::Instant;
pub use wasmtimer::tokio::{
    interval, interval_at, sleep, sleep_until, timeout, Interval, MissedTickBehavior, Sleep,
    Timeout,
};

/// Error types, mirroring `tokio::time::error`.
pub mod error {
    pub use wasmtimer::tokio::error::Elapsed;
}
