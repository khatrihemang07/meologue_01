use std::env;

use meologue_server::{digest, embedding, llm, openapi, period};
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

    let llm_config = llm::LlmConfig::from_env();

    // An unset embed model (with no base URL resolvable from either
    // MEOLOGUE_EMBED_BASE_URL or MEOLOGUE_CHAT_BASE_URL) means the
    // embedding worker never starts and the server runs exactly as it does
    // today — see ADR 0021 and `llm::LlmConfig`.
    let embed_tx = match llm_config.embed_worker_config() {
        Some((client, model_name)) => {
            let (tx, rx) = tokio::sync::mpsc::channel(256);
            tokio::spawn(embedding::run(pool.clone(), client, model_name, rx, embedding::SCAN_INTERVAL));
            Some(tx)
        }
        None => None,
    };

    // An unset chat base URL/model means the Digest worker never spawns and
    // the Server runs exactly as it does today — ADR 0021's "unset config
    // means the feature is off", extended to Digests by ADR 0027. Unlike
    // Reflection below, this needs no embed client at all (a Digest
    // retrieves by date range, not by vector search), so it's gated on its
    // own, looser check — see `LlmConfig::digest_worker_config`.
    if let Some(chat_client) = llm_config.digest_worker_config() {
        tokio::spawn(digest::run(
            pool.clone(),
            chat_client,
            period::server_timezone(),
            digest::SCAN_INTERVAL,
        ));
    }

    // An unset chat base URL/model (or an unresolvable embed config —
    // Reflection needs both, see `LlmConfig::reflect_config`) means
    // `/v1/reflect` is never registered at all — ticket 4.
    let reflect = llm_config
        .reflect_config()
        .map(|(chat_client, embed_client)| meologue_server::reflect::ReflectState { chat_client, embed_client });

    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| DEFAULT_STATIC_DIR.to_string());
    let app = meologue_server::router_with_reflection(pool, static_dir, embed_tx, reflect);

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
