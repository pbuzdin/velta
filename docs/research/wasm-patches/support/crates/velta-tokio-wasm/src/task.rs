// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Velta contributors. Velta-original (clean-room, see
// docs/research/wasm-patches/velta-tokio-wasm-requirements.md).

//! Tasks on the JS event loop. There is a single thread, so "blocking"
//! helpers simply run their closure.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

/// Why awaiting a [`JoinHandle`] failed. Panics abort the wasm instance, so
/// the only reachable cause is cancellation.
pub struct JoinError {
    cancelled: bool,
}

impl JoinError {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }
    pub fn is_panic(&self) -> bool {
        !self.cancelled
    }
}

impl fmt::Debug for JoinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "JoinError::{}",
            if self.cancelled { "Cancelled" } else { "Panic" }
        )
    }
}

impl fmt::Display for JoinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(if self.cancelled {
            "task was cancelled"
        } else {
            "task panicked"
        })
    }
}

impl std::error::Error for JoinError {}

/// State shared by a running task, its [`JoinHandle`] and [`AbortHandle`]s.
#[derive(Default)]
struct Control {
    abort_requested: bool,
    finished: bool,
    /// Waker of the spawned task, so `abort` can make it notice promptly.
    task_waker: Option<Waker>,
    /// Waker of whoever awaits the `JoinHandle`.
    join_waker: Option<Waker>,
}

struct Slot<T> {
    control: Mutex<Control>,
    output: Mutex<Option<Result<T, JoinError>>>,
}

/// Cancels a task without owning its output.
#[derive(Clone)]
pub struct AbortHandle {
    control: Arc<dyn AbortTarget>,
}

trait AbortTarget: Send + Sync {
    fn request_abort(&self);
    fn is_finished(&self) -> bool;
}

impl<T: Send> AbortTarget for Slot<T> {
    fn request_abort(&self) {
        let mut c = self.control.lock().unwrap();
        if !c.finished {
            c.abort_requested = true;
            if let Some(w) = c.task_waker.take() {
                w.wake();
            }
        }
    }
    fn is_finished(&self) -> bool {
        self.control.lock().unwrap().finished
    }
}

impl AbortHandle {
    pub fn abort(&self) {
        self.control.request_abort();
    }
    pub fn is_finished(&self) -> bool {
        self.control.is_finished()
    }
}

impl fmt::Debug for AbortHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AbortHandle")
    }
}

/// Owned permission to await a spawned task's output. Dropping it detaches
/// the task (it keeps running), like tokio.
pub struct JoinHandle<T> {
    slot: Arc<Slot<T>>,
}

impl<T> fmt::Debug for JoinHandle<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JoinHandle")
    }
}

impl<T> JoinHandle<T> {
    pub fn abort(&self) {
        self.slot_abort();
    }
    pub fn is_finished(&self) -> bool {
        self.slot.control.lock().unwrap().finished
    }
}

impl<T: Send + 'static> JoinHandle<T> {
    pub fn abort_handle(&self) -> AbortHandle {
        AbortHandle {
            control: self.slot.clone(),
        }
    }
}

impl<T> Unpin for JoinHandle<T> {}

impl<T> Future for JoinHandle<T> {
    type Output = Result<T, JoinError>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut control = self.slot.control.lock().unwrap();
        if control.finished {
            drop(control);
            if let Some(out) = self.slot.output.lock().unwrap().take() {
                return Poll::Ready(out);
            }
            // Output already taken by an earlier poll: behave like a cancelled join.
            return Poll::Ready(Err(JoinError { cancelled: true }));
        }
        control.join_waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

/// The future actually handed to the JS executor: runs the user's future
/// unless an abort was requested, then publishes the result.
struct Driver<F: Future> {
    inner: Pin<Box<F>>,
    slot: Arc<Slot<F::Output>>,
}

impl<F: Future> Future for Driver<F> {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let aborted = {
            let mut c = self.slot.control.lock().unwrap();
            c.task_waker = Some(cx.waker().clone());
            c.abort_requested
        };
        let result = if aborted {
            Err(JoinError { cancelled: true })
        } else {
            match self.inner.as_mut().poll(cx) {
                Poll::Ready(v) => Ok(v),
                Poll::Pending => return Poll::Pending,
            }
        };
        *self.slot.output.lock().unwrap() = Some(result);
        let waker = {
            let mut c = self.slot.control.lock().unwrap();
            c.finished = true;
            c.task_waker = None;
            c.join_waker.take()
        };
        if let Some(w) = waker {
            w.wake();
        }
        Poll::Ready(())
    }
}

/// Runs `future` concurrently on the JS event loop. Unlike tokio, `Send`
/// is not required (there is one thread), so this also serves as
/// `spawn_local`.
pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + 'static,
    F::Output: 'static,
{
    let slot = Arc::new(Slot {
        control: Mutex::new(Control::default()),
        output: Mutex::new(None),
    });
    let driver = Driver {
        inner: Box::pin(future),
        slot: slot.clone(),
    };
    wasm_bindgen_futures::spawn_local(driver);
    JoinHandle { slot }
}

/// Same as [`spawn`].
pub fn spawn_local<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + 'static,
    F::Output: 'static,
{
    spawn(future)
}

/// Runs `f` as a separate task. It still executes on the only thread, so
/// long closures stall the page exactly as long as they run.
pub fn spawn_blocking<F, R>(f: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + 'static,
    R: 'static,
{
    spawn(async move { f() })
}

/// Runs `f` right here (nothing to hand the worker thread off to).
pub fn block_in_place<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    f()
}

/// Lets other tasks run once before continuing.
pub async fn yield_now() {
    struct YieldOnce(bool);
    impl Future for YieldOnce {
        type Output = ();
        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
            if self.0 {
                Poll::Ready(())
            } else {
                self.0 = true;
                cx.waker().wake_by_ref();
                Poll::Pending
            }
        }
    }
    YieldOnce(false).await
}

/// A set of spawned tasks whose outputs are collected in completion order.
pub struct JoinSet<T> {
    tasks: Vec<JoinHandle<T>>,
}

impl<T> Default for JoinSet<T> {
    fn default() -> Self {
        JoinSet { tasks: Vec::new() }
    }
}

impl<T> fmt::Debug for JoinSet<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "JoinSet({} tasks)", self.tasks.len())
    }
}

impl<T: Send + 'static> JoinSet<T> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.tasks.len()
    }
    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }
    pub fn spawn<F>(&mut self, future: F) -> AbortHandle
    where
        F: Future<Output = T> + 'static,
    {
        let handle = spawn(future);
        let abort = handle.abort_handle();
        self.tasks.push(handle);
        abort
    }
    pub fn spawn_local<F>(&mut self, future: F) -> AbortHandle
    where
        F: Future<Output = T> + 'static,
    {
        self.spawn(future)
    }
    /// Waits for any task to finish; `None` when the set is empty.
    pub async fn join_next(&mut self) -> Option<Result<T, JoinError>> {
        if self.tasks.is_empty() {
            return None;
        }
        std::future::poll_fn(|cx| self.poll_join_next(cx)).await
    }
    pub fn poll_join_next(&mut self, cx: &mut Context<'_>) -> Poll<Option<Result<T, JoinError>>> {
        if self.tasks.is_empty() {
            return Poll::Ready(None);
        }
        for i in 0..self.tasks.len() {
            if let Poll::Ready(out) = Pin::new(&mut self.tasks[i]).poll(cx) {
                self.tasks.swap_remove(i);
                return Poll::Ready(Some(out));
            }
        }
        Poll::Pending
    }
    pub fn try_join_next(&mut self) -> Option<Result<T, JoinError>> {
        let i = self.tasks.iter().position(|t| t.is_finished())?;
        let mut h = self.tasks.swap_remove(i);
        let waker = Waker::noop();
        match Pin::new(&mut h).poll(&mut Context::from_waker(waker)) {
            Poll::Ready(out) => Some(out),
            Poll::Pending => None,
        }
    }
    pub fn abort_all(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
    pub fn detach_all(&mut self) {
        self.tasks.clear();
    }
    pub async fn shutdown(&mut self) {
        self.abort_all();
        while self.join_next().await.is_some() {}
    }
    pub async fn join_all(mut self) -> Vec<T> {
        let mut out = Vec::with_capacity(self.tasks.len());
        while let Some(r) = self.join_next().await {
            match r {
                Ok(v) => out.push(v),
                Err(e) => panic!("{e}"),
            }
        }
        out
    }
}

impl<T> Drop for JoinSet<T> {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.slot_abort();
        }
    }
}

impl<T> JoinHandle<T> {
    fn slot_abort(&self) {
        let mut c = self.slot.control.lock().unwrap();
        if !c.finished {
            c.abort_requested = true;
            if let Some(w) = c.task_waker.take() {
                w.wake();
            }
        }
    }
}
