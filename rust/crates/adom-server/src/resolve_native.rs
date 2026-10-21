//! `/resolve` nativo por debrid (`RESOLVE_RUST=on`).
//!
//! O HMAC é o mesmo do Node (`infoHash + ?s=S&e=E + &w=<hint>`); a config da
//! URL (`/<segmento>/resolve/<hash>`) é decodificada com o mesmo `decode_config`
//! do núcleo para achar `debridService`/`debridApiKey`. A resolução em si é do
//! `adom_debrid::play` (um adaptador por serviço) e o erro vira o MESMO status/
//! texto do `src/routes/resolve.ts`.
//!
//! Sem adaptador (P2P puro, serviço desconhecido ou sem chave) o Node devolve
//! `null` do `current()` e responde 404 "ainda baixando" — a rota nativa copia
//! isso em vez de inventar 500.
//!
//! Efeitos L1 (`magnetdb`, `davail`, invalidação do `streams.db`, ledger do RD)
//! continuam no Node: esta rota só responde o play. Ver o relatório da F4.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use adom_core::{decode_config, PlayHint, WorkHint};
use adom_debrid::play::{self, PlayOutcome};
use adom_debrid::resolve_effects::resolve_effect;
use adom_debrid::{DebridError, HttpClient};
use adom_search::{resolve_play_from, verify_resolve_play, ResolvePlay, ResolveVerify};
use axum::body::Body;
use axum::response::IntoResponse;
use http::header::{CONTENT_TYPE, LOCATION};
use http::{HeaderValue, Response, StatusCode};
use serde_json::Value;

/// Resolve o play; trait para o teste da rota não tocar debrid.
pub trait PlayResolver: Send + Sync {
    fn resolve<'a>(
        &'a self,
        service: &'a str,
        api_key: &'a str,
        info_hash: &'a str,
        hint: &'a PlayHint,
    ) -> Pin<Box<dyn Future<Output = Result<PlayOutcome, DebridError>> + Send + 'a>>;
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
    ) -> Pin<Box<dyn Future<Output = Result<PlayOutcome, DebridError>> + Send + 'a>> {
        Box::pin(async move {
            let Some(client) = self.client.clone() else {
                return Err(DebridError::other("cliente http indisponivel"));
            };
            play::resolve(service, api_key, info_hash, hint, client).await
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
    ) -> Pin<Box<dyn Future<Output = Result<PlayOutcome, DebridError>> + Send + 'a>> {
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
    match ctx
        .resolver
        .resolve(&config.service, &config.api_key, &play.info_hash, &hint)
        .await
    {
        Ok(outcome) => match outcome.url {
            Some(url) => redirect(&url),
            None => still_downloading(),
        },
        Err(err) => error_response(&config.service, &play.info_hash, &err),
    }
}

/// `?s=<S>&e=<E>` (só existe quando os dois vieram). Números inválidos viram
/// `None`, como o `Number(x)` com `NaN` não casa o seletor.
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

fn ep_parts(ep: &str) -> (Option<i64>, Option<i64>) {
    let Some(rest) = ep.strip_prefix("?s=") else {
        return (None, None);
    };
    let Some((season, episode)) = rest.split_once("&e=") else {
        return (None, None);
    };
    (season.parse().ok(), episode.parse().ok())
}

/// Dica `w` do build: `{n:[...], y:ano, p:1, d:1}` — nomes limitados a 4, como
/// o `.slice(0, 4)` do Node.
fn parse_hint_json(raw: &str) -> (Vec<String>, Option<i64>, bool, bool) {
    if raw.is_empty() {
        return (Vec::new(), None, false, false);
    }
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else {
        return (Vec::new(), None, false, false);
    };
    let names = map
        .get("n")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(4)
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let year = map.get("y").and_then(json_i64).filter(|year| *year != 0);
    let pack = is_one(map.get("p"));
    let dubbed = is_one(map.get("d"));
    (names, year, pack, dubbed)
}

fn is_one(value: Option<&Value>) -> bool {
    // `parsed.p === 1` / `parsed.d === 1` no TS: comparação ESTRITA. A dica é
    // gerada pelo build com número 1; string `"1"` não liga (e um hint forjado
    // assinado pelo próprio usuário não pode divergir do Node).
    match value {
        Some(Value::Number(number)) => number.as_i64() == Some(1) || number.as_f64() == Some(1.0),
        _ => false,
    }
}

fn json_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().filter(|n| n.is_finite()).map(|n| n as i64)),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
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

/// Mesmo status/texto do `routes/resolve.ts`; `resolve_effect` é a régua única.
fn error_response(service: &str, info_hash: &str, err: &DebridError) -> Response<Body> {
    let effect = resolve_effect(service, err);
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
    fn hint_w_estrito_como_o_node() {
        let (names, year, pack, dubbed) =
            parse_hint_json(r#"{"n":["Filme"],"y":2024,"p":1,"d":1}"#);
        assert_eq!(names, vec!["Filme"]);
        assert_eq!(year, Some(2024));
        assert!(pack);
        assert!(dubbed);
        // `"1"` string não liga `p`/`d` (o TS compara `=== 1`).
        let (_, _, pack, dubbed) = parse_hint_json(r#"{"n":["Filme"],"p":"1","d":"1"}"#);
        assert!(!pack);
        assert!(!dubbed);
        // Dica ilegível é ausente, nunca erro de rota.
        assert_eq!(
            parse_hint_json("não-json"),
            (Vec::new(), None, false, false)
        );
    }

    #[test]
    fn s_e_so_existem_juntos() {
        assert_eq!(ep_parts("?s=2&e=5"), (Some(2), Some(5)));
        assert_eq!(ep_parts(""), (None, None));
        assert_eq!(ep_parts("?s=abc&e=5"), (None, Some(5)));
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
