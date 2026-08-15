//! extractd — lean concurrent extraction service.
//!
//! fetch -> readability -> markdown, over plain HTTP. No browser, no Python, no
//! Playwright. One shared connection pool, a bounded worker permit set, and CPU
//! parsing pushed onto the blocking pool so it never stalls the reactor.
//!
//!   GET  /health
//!   POST /extract        {url, max_chars?, format?}          -> one document
//!   POST /extract_batch  {urls[], max_chars?, format?}       -> many, concurrently
//!
//! `format` is "markdown" (default), "text", or "html".
//!
//! This covers the common case — static and server-rendered pages — at a small
//! fraction of the cost of a headless browser. Pages that genuinely require JS
//! execution are not this service's job: it reports `ok: false` with a reason so
//! the caller can fall through to a browser-backed extractor.

use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use dom_smoothie::{Article, Config, Readability};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

const DEFAULT_MAX_CHARS: usize = 20_000;
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    /// Caps concurrent outbound fetches regardless of how large a batch is.
    permits: Arc<Semaphore>,
    max_bytes: usize,
}

#[derive(Deserialize)]
struct ExtractReq {
    url: String,
    #[serde(default)]
    max_chars: Option<usize>,
    #[serde(default)]
    format: Option<String>,
}

#[derive(Deserialize)]
struct BatchReq {
    urls: Vec<String>,
    #[serde(default)]
    max_chars: Option<usize>,
    #[serde(default)]
    format: Option<String>,
}

#[derive(Serialize)]
struct Doc {
    url: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    byline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    chars: usize,
    truncated: bool,
    elapsed_ms: u128,
}

impl Doc {
    fn failed(url: &str, err: impl Into<String>, started: Instant) -> Self {
        Doc {
            url: url.to_string(),
            ok: false,
            title: None,
            byline: None,
            content: None,
            error: Some(err.into()),
            chars: 0,
            truncated: false,
            elapsed_ms: started.elapsed().as_millis(),
        }
    }
}

/// Readability + markdown conversion. Runs on the blocking pool: it is pure CPU
/// work, and `Readability` is not `Send` (it is built and dropped inside here).
fn render(html: String, url: String, format: &str) -> Result<(Option<String>, Option<String>, String), String> {
    let cfg = Config::default();
    let mut ra = Readability::new(html, Some(url.as_str()), Some(cfg))
        .map_err(|e| format!("readability init: {e}"))?;
    let article: Article = ra.parse().map_err(|e| format!("readability parse: {e}"))?;

    let title = {
        let t = article.title.to_string();
        if t.trim().is_empty() { None } else { Some(t) }
    };
    let byline = article.byline.as_ref().map(|b| b.to_string()).filter(|b| !b.trim().is_empty());

    let body = match format {
        "html" => article.content.to_string(),
        "text" => article.text_content.to_string(),
        _ => htmd::convert(&article.content.to_string())
            .map_err(|e| format!("markdown: {e}"))?,
    };

    Ok((title, byline, body))
}

async fn extract_one(st: &AppState, url: &str, max_chars: usize, format: &str) -> Doc {
    let started = Instant::now();

    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Doc::failed(url, "url must be http(s)", started);
    }

    let _permit = match st.permits.clone().acquire_owned().await {
        Ok(p) => p,
        Err(_) => return Doc::failed(url, "server shutting down", started),
    };

    let resp = match st.client.get(url).send().await {
        Ok(r) => r,
        Err(e) => return Doc::failed(url, format!("fetch: {e}"), started),
    };
    if !resp.status().is_success() {
        return Doc::failed(url, format!("http {}", resp.status().as_u16()), started);
    }

    // Skip non-HTML payloads rather than feeding binary to the parser.
    if let Some(ct) = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) {
        let ct = ct.to_ascii_lowercase();
        if !(ct.contains("html") || ct.contains("xml") || ct.contains("text/plain")) {
            return Doc::failed(url, format!("unsupported content-type: {ct}"), started);
        }
    }

    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => return Doc::failed(url, format!("read body: {e}"), started),
    };
    if body.len() > st.max_bytes {
        return Doc::failed(url, format!("document too large ({} bytes)", body.len()), started);
    }

    let url_owned = url.to_string();
    let fmt = format.to_string();
    let rendered = tokio::task::spawn_blocking(move || render(body, url_owned, &fmt)).await;

    let (title, byline, mut content) = match rendered {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return Doc::failed(url, e, started),
        Err(e) => return Doc::failed(url, format!("worker: {e}"), started),
    };

    let full = content.chars().count();
    let truncated = full > max_chars;
    if truncated {
        content = content.chars().take(max_chars).collect();
    }

    Doc {
        url: url.to_string(),
        ok: true,
        title,
        byline,
        chars: content.chars().count(),
        content: Some(content),
        error: None,
        truncated,
        elapsed_ms: started.elapsed().as_millis(),
    }
}

fn norm_format(f: &Option<String>) -> String {
    match f.as_deref() {
        Some("html") => "html".into(),
        Some("text") => "text".into(),
        _ => "markdown".into(),
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "extractd",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn extract(State(st): State<AppState>, Json(req): Json<ExtractReq>) -> (StatusCode, Json<Doc>) {
    let doc = extract_one(
        &st,
        &req.url,
        req.max_chars.unwrap_or(DEFAULT_MAX_CHARS),
        &norm_format(&req.format),
    )
    .await;
    (StatusCode::OK, Json(doc))
}

async fn extract_batch(State(st): State<AppState>, Json(req): Json<BatchReq>) -> (StatusCode, Json<Vec<Doc>>) {
    let max_chars = req.max_chars.unwrap_or(DEFAULT_MAX_CHARS);
    let format = norm_format(&req.format);

    // Every URL is dispatched at once; the semaphore is what actually bounds
    // in-flight work, so batch size and concurrency stay independent.
    let mut tasks = Vec::with_capacity(req.urls.len());
    for url in req.urls {
        let st = st.clone();
        let fmt = format.clone();
        tasks.push(tokio::spawn(async move { extract_one(&st, &url, max_chars, &fmt).await }));
    }

    let mut out = Vec::with_capacity(tasks.len());
    for t in tasks {
        match t.await {
            Ok(d) => out.push(d),
            Err(e) => out.push(Doc::failed("", format!("join: {e}"), Instant::now())),
        }
    }
    (StatusCode::OK, Json(out))
}

#[tokio::main]
async fn main() {
    let port = env_usize("EXTRACTD_PORT", 11236) as u16;
    let concurrency = env_usize("EXTRACTD_CONCURRENCY", 32);
    let timeout_s = env_usize("EXTRACTD_TIMEOUT_SECS", 25) as u64;
    let max_bytes = env_usize("EXTRACTD_MAX_BYTES", 8 * 1024 * 1024);

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(timeout_s))
        .connect_timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(8)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .expect("http client");

    let state = AppState {
        client,
        permits: Arc::new(Semaphore::new(concurrency)),
        max_bytes,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/extract", post(extract))
        .route("/extract_batch", post(extract_batch))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    eprintln!("extractd listening on http://{addr} (concurrency={concurrency}, timeout={timeout_s}s)");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("serve");
}
