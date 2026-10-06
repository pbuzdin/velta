// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Velta contributors. Velta-original (clean-room, see
// docs/research/wasm-patches/velta-tokio-wasm-requirements.md).

//! `tokio` stand-in for chatmail core in Velta's opt-in wasm build.
//!
//! Core depends on a crate named `tokio`; Cargo will not let that name point
//! at different packages per target, so the wasm patch series renames the
//! dependency to this crate everywhere.
//!
//! * Native targets: this crate *is* tokio (`pub use tokio::*`, feature
//!   `full`). Nothing else is compiled.
//! * `wasm32-unknown-unknown`: tokio's portable parts are passed through and
//!   the OS-bound parts (`time`, `task`, `fs`, `net`) are provided by
//!   small browser-backed modules in this crate.

#[cfg(not(target_arch = "wasm32"))]
pub use tokio::*;

#[cfg(target_arch = "wasm32")]
pub use tokio::{io, join, pin, select, sync, task_local, try_join};

#[cfg(target_arch = "wasm32")]
pub mod fs;
#[cfg(target_arch = "wasm32")]
pub mod net;
#[cfg(target_arch = "wasm32")]
pub mod runtime;
#[cfg(target_arch = "wasm32")]
pub mod task;
#[cfg(target_arch = "wasm32")]
pub mod time;

#[cfg(target_arch = "wasm32")]
pub use task::spawn;
