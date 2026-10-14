//! Gate chain + cache + coalescing. Espelho de
//! resolvers/profiles/bludv-gate-flow.ts.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::watch;
use url::Url;

use super::gate_links::{is_gate_url, safe_gate_url};
use super::gate_transport::{
    at_regex, check_allowed, GateError, GateResult, GateTransport, UrlGuard,
};

/// Cache de sucesso (30 min). Falha NUNCA entra aqui.
static CACHE: LazyLock<Mutex<HashMap<String, (String, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const CACHE_TTL_SECS: u64 = 30 * 60;
const MAX_CACHE: usize = 128;

/// Coalescing por URL do gate. Usa watch channel para evitar corrida no Notify.
static IN_FLIGHT: LazyLock<Mutex<HashMap<String, Arc<InFlight>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const MAX_WAITERS: usize = 32;

/// Uma cadeia por vez por processo (fila com teto).
static GATE_SEMAPHORE: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(1));
const MAX_QUEUED: usize = 8;

struct InFlight {
    tx: watch::Sender<Option<Result<String, GateError>>>,
    waiters: Mutex<usize>,
}

/// Configuracao injetavel da cadeia.
#[derive(Debug, Clone)]
pub struct GateConfig {
    pub solver_url: String,
    pub timeout: Duration,
    pub min_wait: Duration,
}

impl Default for GateConfig {
    fn default() -> Self {
        Self {
            solver_url: "http://127.0.0.1:8191".into(),
            timeout: Duration::from_millis(120_000),
            min_wait: Duration::from_millis(30_000),
        }
    }
}

/// Extrai o primeiro href que passa no guard.
fn href_of(html: &str, base: &str, guard: &UrlGuard) -> GateResult<String> {
    static HREF_RE: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
        fancy_regex::Regex::new(r#"(?is)<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1"#)
            .expect("href regex")
    });
    for caps in HREF_RE.captures_iter(html).flatten() {
        let decoded = crate::common::text::decode_entities(caps[2].trim());
        if let Some(url) = safe_gate_url(&decoded, Some(base)) {
            if guard(&url) {
                return Ok(url.to_string());
            }
        }
    }
    Err(GateError::refused("botao de saida ausente"))
}

/// Cadeia completa gate -> magnet. Sessao DESTRUIDA no finally.
async fn run_chain(
    transport: &dyn GateTransport,
    gate: &Url,
    config: &GateConfig,
) -> GateResult<String> {
    let started = Instant::now();
    let result = try_chain(transport, gate, config, started).await;
    transport.destroy_session().await;
    result
}

async fn try_chain(
    transport: &dyn GateTransport,
    gate: &Url,
    config: &GateConfig,
    started: Instant,
) -> GateResult<String> {
    transport.create_session().await?;
    let gate_host = gate.host_str().unwrap_or("");
    let jump_guard = at_regex("promobr.online", r"^/jump/.+");

    // 1. Flare GET gate -> promobr.online/jump/
    let landing = transport.flare_get(gate.as_str(), &*jump_guard).await?;

    // 2. HTML promocao -> extrai href x.gd
    let promo_html = transport.follow_text(landing.url.as_str(), &*jump_guard).await?;
    let xg_guard = at_regex("x.gd", r"^/");
    let short_url = href_of(&promo_html, landing.url.as_str(), &*xg_guard)?;

    // 3. GET x.gd redirect manual -> valedesconto.shop/r/...?utm_content=CODE
    let redir = transport.direct_get(&short_url).await?;
    let voucher = redir.location.ok_or_else(|| GateError::refused("sem location"))?;
    if !at_regex("valedesconto.shop", r"^/r/.+")(&voucher) {
        return Err(GateError::refused("saida do encurtador invalida"));
    }
    let codes: Vec<String> = voucher
        .query_pairs()
        .filter(|(k, _)| k.as_ref() == "utm_content")
        .map(|(_, v)| v.into_owned())
        .collect();
    if codes.len() != 1 {
        return Err(GateError::refused("codigo do anuncio invalido"));
    }
    let code = &codes[0];
    if code.is_empty()
        || code.len() > 512
        || !code.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'_' | b'=' | b'-')
        })
    {
        return Err(GateError::refused("codigo do anuncio invalido"));
    }

    // 4. GET promobr.online/api/end?code=... -> JSON.url
    let mut api_url =
        Url::parse("https://promobr.online/api/end").map_err(|_| GateError::refused("api"))?;
    api_url.query_pairs_mut().append_pair("code", code);
    let api_guard = at_regex("promobr.online", r"^/api/end$");
    let api_body = transport.follow_text(api_url.as_str(), &*api_guard).await?;
    let json: serde_json::Value =
        serde_json::from_str(&api_body).map_err(|_| GateError::refused("api sem saida"))?;
    let hop_str = json
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| GateError::refused("api sem saida"))?;
    let hop = check_allowed(gate_host, hop_str, Some(api_url.as_str()))?;
    let hop_guard = at_regex("promobr.online", r"^/hop/.+");
    if !hop_guard(&hop) {
        return Err(GateError::refused("hop invalido"));
    }

    // 5. GET /hop/ -> extrai href /go/
    let hop_html = transport.follow_text(hop.as_str(), &*hop_guard).await?;
    let go_guard = at_regex("promobr.online", r"^/go/.+");
    let go_url = href_of(&hop_html, hop.as_str(), &*go_guard)?;

    // 6. GET /go/ redirect manual -> callback no gate host
    let go_res = transport.direct_get(&go_url).await?;
    let callback =
        go_res.location.ok_or_else(|| GateError::refused("callback invalido"))?;
    if callback.host_str().unwrap_or("") != gate_host || callback.path() != "/gate/callback" {
        return Err(GateError::refused("callback invalido"));
    }
    let tok_n = callback.query_pairs().filter(|(k,_)| k.as_ref()=="token").count();
    let ref_n = callback.query_pairs().filter(|(k,_)| k.as_ref()=="ref").count();
    let tok_ok = callback.query_pairs().any(|(k,v)| k.as_ref()=="token" && !v.is_empty());
    let ref_ok = callback.query_pairs().any(|(k,v)| k.as_ref()=="ref" && !v.is_empty());
    if tok_n != 1 || ref_n != 1 || !tok_ok || !ref_ok {
        return Err(GateError::refused("callback invalido"));
    }

    // 7. Espera minima desde INICIO do gate
    let elapsed = started.elapsed();
    if config.min_wait > elapsed {
        tokio::time::sleep(config.min_wait - elapsed).await;
    }

    // 8. Flare GET callback -> magnet
    let cb_guard: Box<UrlGuard> = {
        let h = gate_host.to_string();
        Box::new(move |u: &Url| u.host_str().unwrap_or("") == h)
    };
    let solved = transport.flare_get(callback.as_str(), &*cb_guard).await?;
    if solved.url.query_pairs().any(|(k,_)| k.as_ref()=="gate_erro") {
        return Err(GateError::refused("callback recusado"));
    }
    let decoded = crate::common::text::decode_entities(&solved.html);
    let magnet = adom_crawl::br_core::magnet::RICH
        .extract(&decoded)
        .filter(|m| adom_crawl::br_core::magnet::is_valid_magnet_uri(m))
        .ok_or_else(|| GateError::refused("magnet valido ausente"))?;
    Ok(magnet)
}

/// Resolve gate: cache -> coalescing -> fila -> cadeia. Transport injetado.
pub async fn resolve_gate_magnet(
    gate_url: &str,
    post_url: &str,
    transport: Arc<dyn GateTransport>,
    config: &GateConfig,
) -> Result<String, GateError> {
    if !is_gate_url(gate_url, Some(post_url)) {
        return Err(GateError::refused("botao invalido"));
    }
    let gate = safe_gate_url(gate_url, Some(post_url))
        .ok_or_else(|| GateError::refused("botao invalido"))?;
    let key = gate.to_string();

    if let Some(hit) = cache_get(&key) { return Ok(hit); }

    let (flight, rx) = {
        let mut map = IN_FLIGHT.lock().unwrap();
        if let Some(existing) = map.get(&key) {
            let mut w = existing.waiters.lock().unwrap();
            if *w >= MAX_WAITERS { return Err(GateError::refused("consumidores demais")); }
            *w += 1;
            let rx = existing.tx.subscribe();
            (Arc::clone(existing), rx)
        } else {
            if map.len() >= MAX_QUEUED + 1 { return Err(GateError::refused("fila cheia")); }
            let (tx, _rx) = watch::channel(None);
            let f = Arc::new(InFlight { tx, waiters: Mutex::new(1) });
            map.insert(key.clone(), Arc::clone(&f));
            let f2 = Arc::clone(&f);
            let t2 = Arc::clone(&transport);
            let c2 = config.clone();
            let g2 = gate.clone();
            let k2 = key.clone();
            tokio::spawn(async move { run_spawned(f2, t2, c2, g2, k2).await });
            let rx2 = f.tx.subscribe();
            (f, rx2)
        }
    };

    let out = wait_for_result(rx).await;
    let mut w = flight.waiters.lock().unwrap();
    *w = w.saturating_sub(1);
    out
}

async fn wait_for_result(
    mut rx: watch::Receiver<Option<Result<String, GateError>>>,
) -> Result<String, GateError> {
    loop {
        {
            let v = rx.borrow_and_update();
            if let Some(ref r) = *v { return r.clone(); }
        }
        if rx.changed().await.is_err() {
            return Err(GateError::refused("falha na resolucao"));
        }
    }
}

async fn run_spawned(
    flight: Arc<InFlight>,
    transport: Arc<dyn GateTransport>,
    config: GateConfig,
    gate: Url,
    key: String,
) {
    let _permit = GATE_SEMAPHORE.acquire().await;
    let out = tokio::time::timeout(
        config.timeout,
        run_chain(transport.as_ref(), &gate, &config),
    )
    .await;
    let result = match out {
        Ok(Ok(magnet)) => { cache_set(&key, &magnet); Ok(magnet) }
        Ok(Err(e)) => Err(e),
        Err(_) => Err(GateError::Cancelled),
    };
    IN_FLIGHT.lock().unwrap().remove(&key);
    let _ = flight.tx.send(Some(result));
}

fn cache_get(key: &str) -> Option<String> {
    CACHE.lock().unwrap().get(key).and_then(|(m, exp)| {
        if Instant::now() < *exp { Some(m.clone()) } else { None }
    })
}

fn cache_set(key: &str, magnet: &str) {
    let mut c = CACHE.lock().unwrap();
    let now = Instant::now();
    c.retain(|_, (_, e)| now < *e);
    while c.len() >= MAX_CACHE {
        if let Some(k) = c.keys().next().cloned() { c.remove(&k); } else { break; }
    }
    c.insert(
        key.to_string(),
        (magnet.to_string(), now + Duration::from_secs(CACHE_TTL_SECS)),
    );
}

/// Prefetch fire-and-forget (mesma admissao do play).
pub fn prefetch_gate_magnet(
    gate_url: &str,
    post_url: &str,
    transport: Arc<dyn GateTransport>,
    config: &GateConfig,
) {
    let g = gate_url.to_string();
    let p = post_url.to_string();
    let t = Arc::clone(&transport);
    let c = config.clone();
    tokio::spawn(async move { let _ = resolve_gate_magnet(&g, &p, t, &c).await; });
}

#[cfg(test)]
#[path = "bludv_gate_flow_tests.rs"]
mod tests;
