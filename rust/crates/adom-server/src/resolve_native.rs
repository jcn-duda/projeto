//! `/resolve` nativo por debrid — a rota do gateway, sem flag (fase C do F4.7).
//! O rollback não é env: é o commit/imagem anterior (padrão do R8).
//!
//! O HMAC é o mesmo do Node (`infoHash + ?s=S&e=E + &w=<hint>`); a config da URL
//! (`/<segmento>/resolve/<hash>`) usa o mesmo `decode_config` do núcleo para achar
//! `debridService`/`debridApiKey`. A resolução é do `adom_debrid::play` (um
//! adaptador por serviço) e o erro vira o MESMO status/texto do handler TS que
//! saiu na fase C.
//!
//! Sem adaptador (P2P puro, serviço desconhecido ou sem chave) o Node devolve
//! `null` de `current()` e responde 404 "ainda baixando" — a rota copia isso.
//!
//! Os efeitos do play (`magnetdb`, `davail`, prova de arquivo, índice, ledger
//! do RD e a invalidação das listas) moram no Node: a rota os manda pela ponte
//! (`resolve_bridge`, `/internal/resolve/*`). No erro ela espera a gravação
//! antes de responder; no sucesso o 302 sai na hora.

use std::{future::Future, pin::Pin, sync::Arc};

use adom_core::{decode_config, PlayHint, WorkHint};
use adom_debrid::alldebrid::PlayError;
use adom_debrid::play::{self, PlayOutcome};
use adom_debrid::resolve_effects::resolve_effect;
use adom_debrid::{DebridError, HttpClient};
use adom_search::{resolve_play_from, verify_resolve_play, ResolvePlay, ResolveVerify};
use axum::{body::Body, response::IntoResponse};
use http::header::{CONTENT_TYPE, LOCATION};
use http::{HeaderValue, Method, Response, StatusCode};
use serde_json::Value;

use crate::resolve_bridge::{error_payload, ok_payload, EffectTarget, PlayBridge};
use crate::resolve_hint::{ep_parts, hint_imdb, parse_hint_json};

pub type PlayFuture<'a> = Pin<Box<dyn Future<Output = Result<PlayOutcome, PlayError>> + Send + 'a>>;

/// `/resolve` (com ou sem segmento de config) em GET/HEAD — não confunde com
/// futuros `resolve-*`.
pub fn is_native_resolve(method: &Method, path: &str) -> bool {
    (*method == Method::GET || *method == Method::HEAD)
        && adom_search::parse_resolve_path(path).is_some()
}

/// Resolve o play; trait para o teste da rota não tocar debrid. `held` é o
/// hold do autofetch (só a AllDebrid o lê para decidir se apaga o frio).
pub trait PlayResolver: Send + Sync {
    fn resolve<'a>(
        &'a self,
        service: &'a str,
        api_key: &'a str,
        info_hash: &'a str,
        hint: &'a PlayHint,
        held: bool,
    ) -> PlayFuture<'a>;
}

/// Implementação real: `adom_debrid::play` com a espera de produção.
pub struct DebridPlay {
    client: Option<HttpClient>,
}

impl DebridPlay {
    pub fn new() -> Self {
        Self {
            client: HttpClient::new().ok(),
        }
    }
}

impl Default for DebridPlay {
    fn default() -> Self {
        Self::new()
    }
}

impl PlayResolver for DebridPlay {
    fn resolve<'a>(
        &'a self,
        service: &'a str,
        api_key: &'a str,
        info_hash: &'a str,
        hint: &'a PlayHint,
        held: bool,
    ) -> PlayFuture<'a> {
        Box::pin(async move {
            let Some(client) = self.client.clone() else {
                return Err(DebridError::other("cliente http indisponivel").into());
            };
            play::resolve_held(
                service,
                api_key,
                info_hash,
                hint,
                client,
                play::POLL_WAIT,
                held,
            )
            .await
        })
    }
}

/// Resolvedor inerte para os testes que não exercitam o play (nunca chamado).
#[cfg(test)]
pub struct NoopResolver;

#[cfg(test)]
impl PlayResolver for NoopResolver {
    fn resolve<'a>(
        &'a self,
        _service: &'a str,
        _api_key: &'a str,
        _info_hash: &'a str,
        _hint: &'a PlayHint,
        _held: bool,
    ) -> PlayFuture<'a> {
        Box::pin(async { Ok(PlayOutcome::default()) })
    }
}

/// Config efetiva do play (overlay da URL sobre os defaults do operador).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DebridConfig {
    pub service: String,
    pub api_key: String,
}

impl DebridConfig {
    /// `current()` do Node: serviço E chave E serviço conhecido.
    pub fn has_adapter(&self) -> bool {
        !self.service.is_empty() && !self.api_key.is_empty() && play::known_service(&self.service)
    }

    /// `resolveSecret || debridApiKey || ''` (`src/utils/sign.ts`).
    pub fn secret(&self, resolve_secret: &str) -> String {
        if resolve_secret.is_empty() {
            self.api_key.clone()
        } else {
            resolve_secret.to_string()
        }
    }
}

/// Contexto da rota nativa (o `AppState` do proxy empresta os campos).
pub struct NativeContext {
    pub resolve_secret: String,
    pub resolver: Arc<dyn PlayResolver>,
    pub bridge: Arc<dyn PlayBridge>,
}

/// Defaults do operador: a instalação sem config herda `DEBRID_SERVICE`/`_KEY`.
pub fn defaults_from_env() -> Value {
    let service = std::env::var("DEBRID_SERVICE")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let api_key = if allow_env_key() {
        std::env::var("DEBRID_API_KEY").unwrap_or_default()
    } else {
        String::new()
    };
    serde_json::json!({ "debridService": service, "debridApiKey": api_key })
}

/// `String(process.env.DEBRID_ALLOW_ENV_KEY || 'true') === 'true'`: vazio cai no
/// default LIGADO; só o valor exato `true` herda a chave do `.env` (o `'1'` do
/// resto do app NÃO vale aqui — é o gate de credencial do operador).
fn allow_env_key() -> bool {
    allow_env_key_from(std::env::var("DEBRID_ALLOW_ENV_KEY").ok().as_deref())
}

fn allow_env_key_from(raw: Option<&str>) -> bool {
    match raw {
        Some(value) if !value.is_empty() => value == "true",
        _ => true,
    }
}

/// Decodifica o segmento da URL. `Err` só quando o segmento existe e NÃO é
/// config válida (o Node não monta a rota nesse caso).
pub fn debrid_config(
    encoded: Option<&str>,
    resolve_secret: &str,
    defaults: &Value,
) -> Result<DebridConfig, ()> {
    let Some(segment) = encoded else {
        return Ok(config_of(defaults));
    };
    let opts = decode_config(segment, defaults, resolve_secret).ok_or(())?;
    Ok(config_of(&opts))
}

fn config_of(opts: &Value) -> DebridConfig {
    DebridConfig {
        service: opts
            .get("debridService")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase(),
        api_key: opts
            .get("debridApiKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

/// Entrada da rota nativa. Nunca chama o Node.
pub async fn handle(path: &str, query: Option<&str>, ctx: &NativeContext) -> Response<Body> {
    let Some(play) = resolve_play_from(path, query) else {
        return bad_hash();
    };
    if !valid_hash(&play.info_hash) {
        return bad_hash();
    }
    let defaults = defaults_from_env();
    let Ok(config) = debrid_config(play.encoded.as_deref(), &ctx.resolve_secret, &defaults) else {
        // Segmento presente e inválido: o Node não teria a rota montada.
        return not_found("rota não encontrada");
    };
    if !config.has_adapter() {
        // `current()` null: o Node pula o HMAC e devolve o mesmo 404.
        return still_downloading();
    }
    let secret = config.secret(&ctx.resolve_secret);
    match verify_resolve_play(&play, &secret) {
        ResolveVerify::Ok => {}
        ResolveVerify::InvalidHash => return bad_hash(),
        ResolveVerify::Forbidden | ResolveVerify::Unsigned => return forbidden(),
    }
    let hint = play_hint(&play);
    let encoded = play.encoded.clone().unwrap_or_default();
    let held = config.service != "alldebrid" || ctx.bridge.held(&encoded, &play.info_hash).await;
    let imdb = hint_imdb(&play.hint);
    let target = EffectTarget {
        encoded: &encoded,
        service: &config.service,
        hash: &play.info_hash,
        imdb: &imdb,
        season: hint.season,
        episode: hint.episode,
    };
    match ctx
        .resolver
        .resolve(
            &config.service,
            &config.api_key,
            &play.info_hash,
            &hint,
            held,
        )
        .await
    {
        Ok(outcome) => {
            // O 302 não espera a gravação (vivo/arquivos não mudam a lista).
            let payload = ok_payload(&target, &outcome);
            let bridge = ctx.bridge.clone();
            tokio::spawn(async move { bridge.apply(payload).await });
            match outcome.url {
                Some(url) => redirect(&url),
                None => still_downloading(),
            }
        }
        Err(failure) => {
            let effect = resolve_effect(&config.service, &failure.error);
            if let Some(payload) = error_payload(&target, &effect, failure.files.as_deref()) {
                ctx.bridge.apply(payload).await;
            }
            error_response(&effect, &play.info_hash, &failure.error)
        }
    }
}

fn play_hint(play: &ResolvePlay) -> PlayHint {
    let (season, episode) = ep_parts(&play.ep);
    let (names, year, pack, dubbed) = parse_hint_json(&play.hint);
    let work = (!names.is_empty()).then_some(WorkHint { names, year, pack });
    PlayHint {
        season,
        episode,
        work,
        dubbed,
    }
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 40
        && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        && !hash.bytes().all(|byte| byte == b'0')
}

fn text_response(status: StatusCode, body: &str) -> Response<Body> {
    (
        status,
        [(CONTENT_TYPE, "text/plain; charset=utf-8")],
        body.to_string(),
    )
        .into_response()
}

fn redirect(url: &str) -> Response<Body> {
    let Ok(value) = HeaderValue::from_str(url) else {
        return text_response(StatusCode::BAD_GATEWAY, "falha ao resolver no debrid");
    };
    let mut response = text_response(StatusCode::FOUND, "");
    response.headers_mut().insert(LOCATION, value);
    response
}

fn bad_hash() -> Response<Body> {
    text_response(StatusCode::BAD_REQUEST, "infoHash inválido")
}

fn forbidden() -> Response<Body> {
    text_response(StatusCode::FORBIDDEN, "assinatura inválida")
}

fn not_found(body: &str) -> Response<Body> {
    text_response(StatusCode::NOT_FOUND, body)
}

fn still_downloading() -> Response<Body> {
    not_found("o torrent ainda está baixando no debrid")
}

/// Mesmo status/texto do handler TS que saiu; `resolve_effect` é a régua única.
fn error_response(effect: &Value, info_hash: &str, err: &DebridError) -> Response<Body> {
    let status = effect
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|code| u16::try_from(code).ok())
        .and_then(|code| StatusCode::from_u16(code).ok())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let body = effect
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("falha ao resolver no debrid");
    // Só o tipo e o prefixo do hash: a mensagem do upstream pode carregar a
    // chave/URL. O teto da AllDebrid sai como `kind=quota` explícito.
    eprintln!(
        "[resolve] {} kind={} status={}",
        &info_hash[..info_hash.len().min(8)],
        err.kind(),
        status.as_u16()
    );
    text_response(status, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn allow_env_key_so_com_true_exato() {
        // `String(env || 'true') === 'true'`: vazio/ausente herda (true), mas
        // `1`/`false`/`TRUE` desligam a herança.
        assert!(allow_env_key_from(None));
        assert!(allow_env_key_from(Some("")));
        assert!(allow_env_key_from(Some("true")));
        assert!(!allow_env_key_from(Some("1")));
        assert!(!allow_env_key_from(Some("false")));
        assert!(!allow_env_key_from(Some("TRUE")));
    }

    #[test]
    fn config_da_url_sobrepoe_o_default_do_operador() {
        let defaults = json!({"debridService":"alldebrid","debridApiKey":"chave-env"});
        let encoded = adom_core::encode_config(&json!({"ds":"torbox","dk":"chave-url"}));
        let config = debrid_config(Some(&encoded), "", &defaults).unwrap();
        assert_eq!(config.service, "torbox");
        assert_eq!(config.api_key, "chave-url");
        // Sem segmento, herda o default (mesmo `runtime.decode(null)` do Node).
        let config = debrid_config(None, "", &defaults).unwrap();
        assert_eq!(config.service, "alldebrid");
        assert_eq!(config.api_key, "chave-env");
        // Segmento inválido é 404, não config forjada.
        assert!(debrid_config(Some("não-é-base64!"), "", &defaults).is_err());
    }

    #[test]
    fn sem_servico_ou_chave_nao_ha_adaptador() {
        assert!(!DebridConfig::default().has_adapter());
        assert!(!DebridConfig {
            service: "premiumize".into(),
            api_key: String::new(),
        }
        .has_adapter());
        assert!(!DebridConfig {
            service: "stremthru".into(),
            api_key: "k".into(),
        }
        .has_adapter());
        assert!(DebridConfig {
            service: "premiumize".into(),
            api_key: "k".into(),
        }
        .has_adapter());
    }
}
