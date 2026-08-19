use std::env;

use meologue_server::{embedding, llm, openapi};
use sqlx::postgres::PgPoolOptions;

const DEFAULT_DATABASE_URL: &str = "postgres://meologue:meologue@localhost:5432/meologue";
// Relative to the server crate's own directory (cwd when run via `cargo run` from `server/`).
const DEFAULT_STATIC_DIR: &str = "../apps/web/dist/web";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if env::args().nth(1).as_deref() == Some("openapi") {
        println!("{}", openapi::spec().to_pretty_json()?);
        return Ok(());
    }

    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_span_events(tracing_subscriber::fmt::format::FmtSpan::CLOSE)
        .init();

    let database_url = env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_string());
    let pool = PgPoolOptions::new().connect(&database_url).await?;
    sqlx::migrate!().run(&pool).await?;

    // An unset embed model (with no base URL resolvable from either
    // MEOLOGUE_EMBED_BASE_URL or MEOLOGUE_CHAT_BASE_URL) means the
    // embedding worker never starts and the server runs exactly as it does
    // today — see ADR 0021 and `llm::LlmConfig`.
    let embed_tx = match llm::LlmConfig::from_env().embed_worker_config() {
        Some((client, model_name)) => {
            let (tx, rx) = tokio::sync::mpsc::channel(256);
            tokio::spawn(embedding::run(pool.clone(), client, model_name, rx, embedding::SCAN_INTERVAL));
            Some(tx)
        }
        None => None,
    };

    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| DEFAULT_STATIC_DIR.to_string());
    let app = meologue_server::router_with_embedding(pool, static_dir, embed_tx);

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(41207);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!("meologue-server listening on :{port}");
    println!("Server URL for Settings: http://localhost:{port}");
    axum::serve(listener, app).await?;

    Ok(())
}
