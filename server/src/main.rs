use std::env;

use meologue_server::openapi;
use sqlx::postgres::PgPoolOptions;

const DEFAULT_DATABASE_URL: &str = "postgres://meologue:meologue@localhost:5432/meologue";
// Relative to the server crate's own directory (cwd when run via `cargo run` from `server/`).
const DEFAULT_STATIC_DIR: &str = "../apps/web/dist";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if env::args().nth(1).as_deref() == Some("openapi") {
        println!("{}", openapi::spec().to_pretty_json()?);
        return Ok(());
    }

    let database_url = env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_string());
    let pool = PgPoolOptions::new().connect(&database_url).await?;
    sqlx::migrate!().run(&pool).await?;

    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| DEFAULT_STATIC_DIR.to_string());
    let app = meologue_server::router(pool, static_dir);

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!("meologue-server listening on :{port}");
    axum::serve(listener, app).await?;

    Ok(())
}
