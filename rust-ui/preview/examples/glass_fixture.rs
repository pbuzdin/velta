//! Offline, synthetic chats for repeatable desktop glass screenshots. Sends nothing.
//! cargo run --example glass_fixture -- /tmp/velta-glass-fixture
use deltachat::{
    accounts::Accounts,
    chat,
    config::Config,
    message::{Message, Viewtype},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir = std::env::args()
        .nth(1)
        .expect("pass a NEW disposable accounts directory");
    anyhow::ensure!(
        !std::path::Path::new(&dir).exists(),
        "refusing to modify an existing accounts directory"
    );
    let mut accounts = Accounts::new(dir.into(), true).await?;
    accounts.add_account().await?;
    let ctx = accounts.get_selected_account().unwrap();
    ctx.set_config(Config::Addr, Some("glass@example.invalid"))
        .await?;
    for name in [
        "Design notes",
        "Weekend plans",
        "Garden",
        "Book club",
        "Bike rides",
        "Coffee",
        "City walks",
        "Film night",
        "Recipes",
        "Music",
        "Workshop",
        "Sketches",
        "Travel ideas",
        "Family",
        "Photography",
        "Glass prototype",
    ] {
        let id = chat::create_group_unencrypted(&ctx, name).await?;
        let mut draft = Message::new(Viewtype::Text);
        draft.set_text(format!("Offline preview · {name}"));
        id.set_draft(&ctx, Some(&mut draft)).await?;
    }
    Ok(())
}
