// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Velta contributors. Velta-original (clean-room, see
// docs/research/wasm-patches/velta-tokio-wasm-requirements.md).

//! Raw sockets do not exist in a browser. These items only let code that
//! *names* them compile; every operation fails with `Unsupported`. Core's
//! real wasm transport is `net::ws_tcp` (WebSocket → TCP bridge).

use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "raw TCP/DNS is unavailable on wasm32 (use the WebSocket transport)",
    )
}

/// Anything that could name a socket address. Resolution always fails here.
pub trait ToSocketAddrs {}
impl<T: ?Sized> ToSocketAddrs for T {}

/// DNS lookups are not possible from a browser.
pub async fn lookup_host<T: ToSocketAddrs>(_host: T) -> io::Result<std::vec::IntoIter<SocketAddr>> {
    Err(unsupported())
}

/// Placeholder TCP stream; cannot be constructed successfully.
#[derive(Debug)]
pub struct TcpStream {
    _private: (),
}

impl TcpStream {
    pub async fn connect<A: ToSocketAddrs>(_addr: A) -> io::Result<TcpStream> {
        Err(unsupported())
    }
    pub fn peer_addr(&self) -> io::Result<SocketAddr> {
        Err(unsupported())
    }
    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        Err(unsupported())
    }
    pub fn set_nodelay(&self, _nodelay: bool) -> io::Result<()> {
        Err(unsupported())
    }
}

impl AsyncRead for TcpStream {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Err(unsupported()))
    }
}

impl AsyncWrite for TcpStream {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(unsupported()))
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Err(unsupported()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Err(unsupported()))
    }
}
