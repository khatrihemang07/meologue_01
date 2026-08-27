use std::{env, net::Ipv4Addr, process::Command};

use meologue_server::{digest, embedding, llm, openapi, period};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;

const DEFAULT_DATABASE_URL: &str = "postgres://meologue:meologue@localhost:5432/meologue";
// Relative to the server crate's own directory (cwd when run via `cargo run` from `server/`).
const DEFAULT_STATIC_DIR: &str = "../apps/web/dist/web";

struct TailscaleIdentity {
    dns_name: String,
    ipv4: Ipv4Addr,
}

fn tailscale_json(args: &[&str]) -> Option<Value> {
    let output = Command::new("tailscale").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| serde_json::from_slice(&output.stdout).ok())?
}

fn tailscale_identity(status: &Value) -> Option<TailscaleIdentity> {
    (status.get("BackendState")?.as_str()? == "Running").then_some(())?;

    let dns_name = status
        .pointer("/Self/DNSName")?
        .as_str()?
        .trim_end_matches('.')
        .to_owned();
    let ipv4 = status
        .pointer("/Self/TailscaleIPs")?
        .as_array()?
        .iter()
        .find_map(|ip| ip.as_str()?.parse().ok())?;

    Some(TailscaleIdentity { dns_name, ipv4 })
}

fn tailscale_serve_url(status: &Value, dns_name: &str, server_port: u16) -> Option<String> {
    let expected_proxy = format!("http://127.0.0.1:{server_port}");

    status
        .get("Web")?
        .as_object()?
        .iter()
        .find_map(|(host_port, config)| {
            let (host, port) = host_port.rsplit_once(':')?;
            let port: u16 = port.parse().ok()?;
            let proxy = config.get("Handlers")?.get("/")?.get("Proxy")?.as_str()?;
            let is_https = status
                .get("TCP")?
                .get(port.to_string())?
                .get("HTTPS")?
                .as_bool()?;

            (host == dns_name && proxy == expected_proxy && is_https).then(|| {
                if port == 443 {
                    format!("https://{host}")
                } else {
                    format!("https://{host}:{port}")
                }
            })
        })
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

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
    //
    // Bound to a variable (rather than matched inline) so `digests_enabled`
    // survives past the `Some(chat_client)` move below — issue #70's
    // `/v1/digests/*` routes are gated on the same config as the worker
    // itself, via `router_with_digests`, since there is nothing for those
    // routes to serve on a Server whose worker never runs.
    let digest_worker_config = llm_config.digest_worker_config();
    let digests_enabled = digest_worker_config.is_some();
    if let Some(chat_client) = digest_worker_config {
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
    let reflect = match llm_config.reflect_config() {
        Some((chat_client, embed_client)) => {
            // Issue #97: resolved once, at startup, rather than per
            // request — `LlmConfig::resolve_context_window`'s own doc
            // comment covers why.
            let context_window = llm_config.resolve_context_window().await;
            // Issue #96: `GET /v1/models` (`models::models_handler`) needs
            // the raw base URL/API key alongside the two `LlmClient`s above
            // — `reflect_config()` already proved `chat_base_url` is `Some`
            // (it's what built `chat_client`), so this `.expect` documents
            // that invariant rather than guessing past it silently.
            let chat_base_url = llm_config
                .chat_base_url
                .clone()
                .expect("reflect_config() only returns Some when chat_base_url is set");
            let chat_model = llm_config
                .chat_model
                .clone()
                .expect("reflect_config() only returns Some when chat_model is set");
            // Issue #98: whether the configured default model itself
            // streams — resolved once, here, the same "at startup, not per
            // request" reasoning `context_window` above already follows.
            // `list_models` degrades to an empty list on any failure to
            // reach the wrapper (its own doc comment), which folds into
            // `unwrap_or(false)` below the same conservative way an unknown
            // context window folds into `DEFAULT_CONTEXT_WINDOW` — a
            // wrapper Reflection can't reach yet is not a reason to guess
            // it streams.
            let chat_streaming =
                llm::list_models(&chat_base_url, llm_config.chat_api_key.as_deref())
                    .await
                    .into_iter()
                    .find(|model| model.id == chat_model)
                    .map(|model| model.streaming)
                    .unwrap_or(false);
            Some(meologue_server::reflect::ReflectState {
                chat_client,
                embed_client,
                context_window,
                chat_base_url,
                chat_api_key: llm_config.chat_api_key.clone(),
                chat_model,
                chat_streaming,
            })
        }
        None => None,
    };

    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| DEFAULT_STATIC_DIR.to_string());
    let app =
        meologue_server::router_with_digests(pool, static_dir, embed_tx, reflect, digests_enabled);

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(41207);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!("meologue-server listening on :{port}");
    println!("Server URL for Settings: http://localhost:{port}");
    if let Some(identity) =
        tailscale_json(&["status", "--json"]).and_then(|status| tailscale_identity(&status))
    {
        println!(
            "Tailscale MagicDNS URL for Settings: http://{}:{port}",
            identity.dns_name
        );
        println!(
            "Tailscale IP URL for Settings: http://{}:{port}",
            identity.ipv4
        );

        if let Some(url) = tailscale_json(&["serve", "status", "--json"])
            .and_then(|status| tailscale_serve_url(&status, &identity.dns_name, port))
        {
            println!("Tailscale Serve URL for Settings: {url}");
        }
    }
    axum::serve(listener, app).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{tailscale_identity, tailscale_serve_url};

    #[test]
    fn reads_magic_dns_and_ipv4_from_running_tailscale() {
        let status = json!({
            "BackendState": "Running",
            "Self": {
                "DNSName": "laptop.example.ts.net.",
                "TailscaleIPs": ["100.64.0.1", "fd7a:115c:a1e0::1"]
            }
        });

        let identity = tailscale_identity(&status).unwrap();

        assert_eq!(identity.dns_name, "laptop.example.ts.net");
        assert_eq!(identity.ipv4.to_string(), "100.64.0.1");
    }

    #[test]
    fn reads_https_url_only_when_serve_targets_the_server_port() {
        let status = json!({
            "TCP": { "443": { "HTTPS": true } },
            "Web": {
                "laptop.example.ts.net:443": {
                    "Handlers": { "/": { "Proxy": "http://127.0.0.1:41207" } }
                }
            }
        });

        assert_eq!(
            tailscale_serve_url(&status, "laptop.example.ts.net", 41207).as_deref(),
            Some("https://laptop.example.ts.net")
        );
        assert_eq!(
            tailscale_serve_url(&status, "laptop.example.ts.net", 41307),
            None
        );
    }
}
