// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Velta contributors. Velta-original (clean-room, see
// docs/research/wasm-patches/velta-tokio-wasm-requirements.md).

//! There is no runtime object in the browser: futures are driven by the JS
//! event loop. Only what wasm-compiled callers name is provided.

use std::future::Future;

use crate::task::{self, JoinHandle};

/// Stand-in for `tokio::runtime::Handle`: forwards to the free functions in
/// [`crate::task`].
#[derive(Clone, Debug, Default)]
pub struct Handle {
    _private: (),
}

impl Handle {
    /// Always available (there is exactly one event loop).
    pub fn current() -> Handle {
        Handle::default()
    }
    pub fn try_current() -> Result<Handle, std::convert::Infallible> {
        Ok(Handle::default())
    }
    pub fn spawn<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: Future + 'static,
        F::Output: 'static,
    {
        task::spawn(future)
    }
    pub fn spawn_blocking<F, R>(&self, f: F) -> JoinHandle<R>
    where
        F: FnOnce() -> R + 'static,
        R: 'static,
    {
        task::spawn_blocking(f)
    }
}
