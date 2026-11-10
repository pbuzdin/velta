//! Velta Rust preview UI (desktop entry). Experimental, see #314.
//!
//! Usage: velta-preview ACCOUNTS_DIR
//! ACCOUNTS_DIR is an existing Delta Chat / Velta accounts folder (with accounts.toml).

mod core;
mod ui;

fn main() -> anyhow::Result<()> {
    let dir = std::env::args().nth(1).or_else(|| std::env::var("VELTA_ACCOUNTS").ok())
        .ok_or_else(|| anyhow::anyhow!("usage: velta-preview ACCOUNTS_DIR"))?;
    let started = std::time::Instant::now();
    let core = core::Core::open(dir.into())?;
    eprintln!("velta-preview: core open in {} ms as {}", started.elapsed().as_millis(), core.self_addr());
    ui::run(core, started)
}
