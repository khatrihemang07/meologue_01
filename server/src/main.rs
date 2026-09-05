use std::{env, net::Ipv4Addr, process::Command};

use meologue_server::{digest, embedding, llm, openapi, settings};
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

    // Issue #200: the stored-settings load sits here, below the `openapi`
    // early return above and below the migration that creates
    // `server_settings` — both load-bearing. `cargo run -- openapi` never
    // reaches this line at all (see that branch's own comment), so type
    // generation never needs a live Postgres; and the migration has always
    // run first, so this select can assume the table exists rather than
    // handling "not yet migrated" as a third state alongside "no row yet".
    //
    // `settings_locked`/`mode` are each read from process environment
    // exactly once, here, and threaded through `AppState` from this point
    // on (`router_with_settings` below) — never re-read inside a request
    // handler. `settings::resolve` is what actually combines
    // `env_llm_config`/`env_tz` with `stored` into the config every worker
    // and route-registration decision below this point uses; see that
    // function's own doc comment for why `settings_locked` is an input to
    // it rather than a branch taken before calling it.
    let settings_locked = settings::config_locked();
    let mode = settings::instance_mode();
    let env_llm_config = llm::LlmConfig::from_env();
    let env_tz = env::var("MEOLOGUE_TZ").ok();
    let stored_settings = settings::load_stored(&pool).await?;
    let resolved_settings = settings::resolve(
        &env_llm_config,
        env_tz.as_deref(),
        &stored_settings,
        settings_locked,
    );

    let llm_config = resolved_settings.llm_config();

    // Issue #201: seeded once, here, from the same `resolved_settings` the
    // chat/embed/timezone values above just came from — `RuntimeFlags::seed`
    // reads its `locked`-aware `reflect_enabled`/`digest_enabled`/
    // `embeddings_enabled` output, not the raw `stored_settings` row, so a
    // locked Server starts with every flag on regardless of what happens
    // to be stored. Cloned (cheaply — three `Arc`s) into `ReflectState`
    // below, into both background workers, and into the Router itself, so
    // every one of those reads the identical atomics a later `PATCH` will
    // mutate — see `settings::RuntimeFlags`'s own doc comment.
    let flags = settings::RuntimeFlags::seed(&resolved_settings);

    // Issue #97 / #136: how much room the configured chat model has,
    // resolved once here rather than once per feature — `resolve_context_window`
    // is cheap to call even when chat isn't configured at all (it
    // short-circuits to `harness::compaction::DEFAULT_CONTEXT_WINDOW`
    // without a network call whenever `chat_base_url`/`chat_model` aren't
    // both set, see its own doc comment), and Reflection and the Digest
    // worker are gated on exactly those same two fields
    // (`LlmConfig::reflect_config`/`digest_worker_config`), so whenever
    // either is actually enabled this one resolution is the number both of
    // them use. Digest reuses it (issue #136) rather than resolving a
    // second, independent context window, so the worker's tick and a
    // reader's Regenerate press always agree on the same chunking budget
    // Reflection's own compaction trigger agrees on too.
    let context_window = llm_config.resolve_context_window().await;

    // An unset embed model (with no base URL resolvable from either
    // MEOLOGUE_EMBED_BASE_URL or MEOLOGUE_CHAT_BASE_URL) means the
    // embedding worker never starts and the server runs exactly as it does
    // today — see ADR 0021 and `llm::LlmConfig`.
    let embed_tx = match llm_config.embed_worker_config() {
        Some((client, model_name)) => {
            let (tx, rx) = tokio::sync::mpsc::channel(256);
            tokio::spawn(embedding::run(
                pool.clone(),
                client,
                model_name,
                rx,
                embedding::SCAN_INTERVAL,
                flags.clone(),
            ));
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
    // `digest_tz` is read once here, not separately inside the worker and
    // again per HTTP request — the same "one process-wide value" discipline
    // ADR 0027 already requires (`period::server_timezone`'s own doc
    // comment): every Period this process ever computes, whether from the
    // worker's own tick or a reader's Regenerate press (issue #132), has to
    // agree on the same calendar boundaries.
    //
    // `digest_state` (issue #132 / ADR 0039) is what
    // `router_with_digests` uses to decide whether `/v1/digests/*` exists
    // at all *and* what `regenerate_digest_handler` spends its own inline
    // chat call on — a bare `digests_enabled` bool used to be threaded
    // through here on its own; now the `Option<DigestState>` itself is the
    // one thing both decisions read, so they can't drift apart. Built from
    // a clone of `chat_client` so the worker below and the Router each get
    // their own `Arc` to the same underlying client.
    // Issue #200: reads the resolved timezone (stored overlay on
    // `MEOLOGUE_TZ`) rather than calling `period::server_timezone()`
    // directly — that function is still what `settings::resolve` itself
    // calls when nothing is stored, but everything below this point must
    // see the *resolved* value, the same way `llm_config` just above is
    // the resolved chat/embed configuration rather than the raw env one.
    let digest_tz = resolved_settings.timezone();
    let digest_worker_config = llm_config.digest_worker_config();
    let digest_state = digest_worker_config.clone().map(|chat_client| digest::DigestState {
        chat_client,
        tz: digest_tz,
        context_window,
    });
    if let Some(chat_client) = digest_worker_config {
        tokio::spawn(digest::run(
            pool.clone(),
            chat_client,
            digest_tz,
            digest::SCAN_INTERVAL,
            context_window,
            flags.clone(),
        ));
    }

    // An unset chat base URL/model means `/v1/reflect` is never registered
    // at all — ticket 4. Issue #130: an unresolvable embed config no longer
    // takes Reflection down with it — `reflect_config` hands back `None`
    // for the embed client alone, and the loop below simply omits the one
    // tool (`similar_entries`) that needs it; see `LlmConfig::reflect_config`.
    let reflect = match llm_config.reflect_config() {
        Some((chat_client, embed_client)) => {
            // Issue #97 / #136: `context_window` was already resolved once,
            // above, before either Reflection or the Digest worker's own
            // config was even inspected — reused here rather than a second
            // call to `resolve_context_window`, per that function's own
            // "called once, here" reasoning.
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
                flags: flags.clone(),
            })
        }
        None => None,
    };

    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| DEFAULT_STATIC_DIR.to_string());
    let app = meologue_server::router_with_flags(
        pool,
        static_dir,
        embed_tx,
        reflect,
        digest_state,
        settings_locked,
        mode,
        flags,
    );

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(41207);
    // 0.0.0.0 stays the default: Tailscale (tailscale_identity/tailscale_serve_url
    // below) reaches this server over the tailnet's 100.x interface, and a
    // loopback-only default would silently break that path for anyone who hasn't
    // set BIND. BIND exists for the person who wants to narrow it deliberately.
    // `.filter(|b| !b.is_empty())` and not a bare `unwrap_or_else`: server/.env.example
    // ships `BIND=` with no value, and dotenvy sets that as an EMPTY string rather than
    // leaving the variable unset — so `env::var` returns `Ok("")` and the fallback never
    // fires, leaving `bind("", port)` to fail at startup for anyone who copied the example
    // file verbatim. The PORT parse directly above is already tolerant of this by accident
    // (an empty string fails `parse()` and falls through to 41207); this makes BIND
    // tolerant of it on purpose.
    let bind = env::var("BIND")
        .ok()
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "0.0.0.0".to_string());
    let listener = tokio::net::TcpListener::bind((bind.as_str(), port)).await?;
    println!("meologue-server listening on :{port}");
    // Issue #200: `MEOLOGUE_MODE` names the instance; it grants nothing and
    // decides no precedence (`settings::InstanceMode`'s own doc comment) —
    // this line and a later UI banner/log prefix are the only things that
    // ever read it.
    println!("Instance: {}", mode.as_str());
    if settings_locked {
        println!("Config: locked to environment (MEOLOGUE_CONFIG_LOCK is set) — stored settings are ignored.");
    }
    println!("Server URL for Settings: http://localhost:{port}");
    // A loopback bind makes every address below unreachable, so they must not be
    // advertised. Printing "Tailscale IP URL for Settings: http://100.x.y.z:PORT"
    // under BIND=127.0.0.1 hands the reader an address that will refuse the
    // connection, and they have no way to tell from the banner that the bind is
    // why — which is a worse failure than saying nothing, because it looks like
    // Tailscale itself is broken.
    let loopback = matches!(bind.as_str(), "127.0.0.1" | "::1" | "localhost");
    if loopback {
        println!("BIND={bind} — reachable from this machine only; tailnet URLs omitted.");
    }
    if !loopback
        && let Some(identity) =
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
    // Unconditional, not gated on `bind`: 0.0.0.0 is the default and has to stay
    // the default (see the comment above), so a warning that only fired for
    // 0.0.0.0 would print on virtually every run anyway and buys nothing — worse,
    // its absence on the rare BIND=127.0.0.1 run would read as "this run is safe
    // now," which docs/adr/0003 explicitly says is never true. There is no
    // authentication at all: anything that can open a TCP connection to this
    // address can read and write every Entry.
    println!("WARNING: no authentication (docs/adr/0003). Anything that can reach");
    println!("  {bind}:{port} can read and write every Entry. Keep this on localhost or a");
    println!("  tailnet — never a public host.");
    // The lever, only when it has not already been pulled. Telling someone who
    // set BIND=127.0.0.1 to "narrow the bind with BIND=127.0.0.1" reads as though
    // the setting did not take, and trains the reader to skip the whole warning.
    // The no-auth sentence above stays unconditional either way: loopback is not
    // safe, it is merely narrower.
    if !loopback {
        println!("  Narrow it to this machine with BIND=127.0.0.1.");
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
