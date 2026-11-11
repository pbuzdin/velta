//! Velta Rust preview UI (desktop entry). Experimental, see #314.
//!
//! Usage: velta-preview ACCOUNTS_DIR
//! ACCOUNTS_DIR is a Delta Chat / Velta accounts folder; an empty one gets a new
//! account on nine.testrun.org.

use velta_preview::{core, say, ui};

fn main() -> anyhow::Result<()> {
    let dir = std::env::args().nth(1).or_else(|| std::env::var("VELTA_ACCOUNTS").ok())
        .ok_or_else(|| anyhow::anyhow!("usage: velta-preview ACCOUNTS_DIR"))?;
    let started = std::time::Instant::now();
    say("main");
    let core = core::Core::open(dir.into(), &velta_preview::relay_for(&dir))?;
    say(format!("core open as {}", core.self_addr()));
    ui::run(core, started, masonry_winit::app::EventLoop::with_user_event())
}
