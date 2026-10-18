//! Leitura da requisição `/stream` e identidade de cache.
//!
//! Espelha três decisões que hoje vivem no TS e que o orquestrador Rust terá de
//! reproduzir antes de responder qualquer coisa:
//!
//! - **caminho**: `src/routes/addon-router.ts` monta
//!   `/stream/:type/:id/:extra?.json` e o mesmo router é montado sob
//!   `/:userConfig` (`src/routes/register.ts`), então a config viaja no PRIMEIRO
//!   segmento, antes de `stream`;
//! - **config**: `src/runtime.ts` (`decode`) aceita só `[A-Za-z0-9_-]+` até
//!   8192 caracteres, decodifica base64url e exige um objeto JSON;
//! - **chave**: `src/utils/request-key.ts` (`streamsCacheKey`) =
//!   `<prefix streams><type>:<id>:<JSON.stringify(opts sem debridApiKey)>:account:<sha256>`.
//!
//! `request_key` NÃO existe em `adom-core`: o TS chama essa identidade de
//! `streamsCacheKey`/`request_key` no mesmo arquivo, e o núcleo porta apenas
//! `streams_cache_key` + `streams_cache_scope`. Por isso a delegação daqui é
//! direta para `streams_cache_key` — não há segunda fórmula a inventar.
use serde_json::Value;

/// Alvo de uma requisição `/stream` já separado. `encoded` é `Some` quando a
/// instalação veio com config na URL.
///
/// `kind`/`id` são os do protocolo (`movie`/`series` e `tt…` ou `tt…:s:e`),
/// **crus**: percent-decode é do roteador HTTP, não deste parser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamTarget {
    pub kind: String,
    pub id: String,
    pub encoded: Option<String>,
}

/// Segmento base64url de `{}` — config canônica quando a URL não traz
/// `/:userConfig`. O Node e o `InternalSearchClient` recusam `encoded` vazio
/// no corpo de `/internal/search/*`; este valor é o equivalente a defaults.
pub const DEFAULT_CONFIG_SEGMENT: &str = "e30";

/// Corpo das rotas internas / identidade da busca: nunca string vazia.
///
/// - com segmento na URL → passa intacto;
/// - sem segmento / vazio → [`DEFAULT_CONFIG_SEGMENT`].
pub fn encoded_for_internal(encoded: Option<&str>) -> String {
    match encoded.map(str::trim).filter(|s| !s.is_empty()) {
        Some(segment) => segment.to_string(),
        None => DEFAULT_CONFIG_SEGMENT.to_string(),
    }
}

/// Mesmo teto de `runtime.ts`: acima disso o segmento nem é tentado.
const MAX_CONFIG_SEGMENT: usize = 8192;

/// O segmento de config precisa ser base64url "puro" (`[A-Za-z0-9_-]+`), como
/// no `decode` do Node. Validar aqui evita que `%2F` ou espaço passem como se
/// fossem config e só falhem lá na frente.
fn is_config_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= MAX_CONFIG_SEGMENT
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `None` para tudo que não é `/stream/<type>/<id>.json` com config opcional.
///
/// Rejeições deliberadas (sem panic): caminho vazio, query/fragmento (o parser
/// recebe PATH, não URL), `.json` ausente, tipo ou id vazios, segmentos extras
/// (`/:extra.json`, que esta fatia ainda não lê) e `%` não decodificado.
pub fn parse_stream_path(path: &str) -> Option<StreamTarget> {
    // PATH puro: o roteador já separou a query. Aceitar `?`/`#` aqui
    // esconderia um chamador passando URL inteira e mudaria o alvo em silêncio.
    if path.contains('?') || path.contains('#') || !path.starts_with('/') {
        return None;
    }
    let mut raw: Vec<&str> = Vec::new();
    for segment in path[1..].split('/') {
        if segment.is_empty() {
            return None;
        }
        raw.push(segment);
    }
    if raw.iter().any(|s| s.contains('%')) {
        return None;
    }

    let (encoded, rest) = match raw.as_slice() {
        // `["stream", type, "<id>.json"]`
        ["stream", _, _] => (None, &raw[..]),
        // `/stream/...` com segmento extra (`/:extra.json`) ainda NÃO é lido
        // nesta fatia: é o caminho do Stremio com `extra`, não uma config.
        ["stream", ..] => return None,
        // `["<config>", "stream", type, "<id>.json"]`
        [config, "stream", _, _] if is_config_segment(config) => (Some(*config), &raw[1..]),
        _ => return None,
    };

    let kind = rest[1];
    let id = rest[2].strip_suffix(".json")?;
    if kind.is_empty() || id.is_empty() {
        return None;
    }
    Some(StreamTarget {
        kind: kind.to_string(),
        id: id.to_string(),
        encoded: encoded.map(str::to_string),
    })
}

/// Decodifica o segmento base64url em `Value`, como `runtime.decode`.
///
/// Sinapse delegada a `adom_core::decode_config`. Diferenças desta fatia, de
/// propósito: os `defaults` são um objeto VAZIO (os defaults reais vêm do `.env`
/// do operador e vivem no Node) e o segredo é `""`, então uma `dk` selada volta
/// selada — abrir o selo exige `RESOLVE_SECRET` e é etapa de integração.
pub fn decode_user_config(encoded: &str) -> Result<Value, String> {
    let defaults = Value::Object(serde_json::Map::new());
    adom_core::decode_config(encoded, &defaults, "")
        .ok_or_else(|| "configuração inválida".to_string())
}

/// Chave de cache da busca: mesmo algoritmo do `streamsCacheKey` do Node.
///
/// `options` é o objeto de opções JÁ normalizado (o `opts()` da requisição mais
/// `resolveUncached`), com `debridApiKey` dentro: o núcleo remove a chave crua e
/// substitui pelo digest da conta. O host NUNCA entra aqui.
pub fn request_cache_key(stream_type: &str, id: &str, options: &Value) -> String {
    adom_core::streams_cache_key(stream_type, id, options)
}

/// Prazo de resposta deste cliente, em milissegundos.
///
/// O app Power Movie (User-Agent `Dart/…`) declara esperar mais que o Stremio e
/// recebe `app_ms`; qualquer outro cliente fica com `stremio_ms`. A comparação
/// é ASCII e sem caixa (o UA é texto livre; variante de caixa não pode trocar o
/// prazo). Ver `docs/rust-stream-contract.md` §11 para a diferença conhecida em
/// relação ao regex do `.env` (`APP_CLIENT_UA`).
pub fn reply_deadline_ms(user_agent: Option<&str>, stremio_ms: u64, app_ms: u64) -> u64 {
    const PREFIX: &[u8] = b"Dart/";
    let ua = user_agent.unwrap_or("").as_bytes();
    if ua.len() >= PREFIX.len() && ua[..PREFIX.len()].eq_ignore_ascii_case(PREFIX) {
        app_ms
    } else {
        stremio_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn caminho_sem_config() {
        let target = parse_stream_path("/stream/movie/tt0133093.json").expect("deveria casar");
        assert_eq!(target.kind, "movie");
        assert_eq!(target.id, "tt0133093");
        // Parser só lê o path: ausência de segmento ≠ omitir no corpo interno.
        assert_eq!(target.encoded, None);
        assert_eq!(
            encoded_for_internal(target.encoded.as_deref()),
            DEFAULT_CONFIG_SEGMENT
        );
    }

    #[test]
    fn encoded_interno_nunca_vazio() {
        assert_eq!(encoded_for_internal(None), "e30");
        assert_eq!(encoded_for_internal(Some("")), "e30");
        assert_eq!(encoded_for_internal(Some("   ")), "e30");
        assert_eq!(
            encoded_for_internal(Some("eyJwIjoiamFja2V0dCJ9")),
            "eyJwIjoiamFja2V0dCJ9"
        );
    }

    #[test]
    fn caminho_com_config_e_serie() {
        let target = parse_stream_path("/eyJwIjoiamFja2V0dCJ9/stream/series/tt0903747:5:14.json")
            .expect("deveria casar");
        assert_eq!(target.kind, "series");
        assert_eq!(target.id, "tt0903747:5:14");
        assert_eq!(target.encoded.as_deref(), Some("eyJwIjoiamFja2V0dCJ9"));
    }

    #[test]
    fn caminho_rejeitado_sem_panic() {
        for bad in [
            "",
            "/",
            "stream/movie/tt1.json",               // sem barra inicial
            "/stream/movie",                       // falta id
            "/stream/movie/tt1",                   // falta .json
            "/stream/movie/tt1.json/x",            // segmento extra
            "/config/stream/movie",                // falta id
            "/config/stream/movie/tt1.json/extra", // extra depois do id
            "/stream//tt1.json",                   // tipo vazio
            "/stream/movie/.json",                 // id vazio
            "/stream/movie/tt1.json?x=1",          // query no parser de PATH
            "/stream/movie/tt%31.json",            // percent-encoding não decodificado
            "/con fig/stream/movie/tt1.json",      // config com espaço
            "/stream/stream/movie/tt1.json",       // 4 segmentos sem config válida
        ] {
            assert_eq!(parse_stream_path(bad), None, "deveria rejeitar {bad:?}");
        }
    }

    #[test]
    fn caminho_aceita_id_com_dois_pontos() {
        let target = parse_stream_path("/stream/series/tt0903747:1:1.json").unwrap();
        assert_eq!(target.id, "tt0903747:1:1");
    }

    #[test]
    fn decode_aplica_overlay() {
        // base64url de {"p":"jackett","m":20}
        let encoded = "eyJwIjoiamFja2V0dCIsIm0iOjIwfQ";
        let value = decode_user_config(encoded).expect("config válida");
        // `normalize_overlay` devolve o objeto com os NOMES LONGS do SCHEMA
        // (`providers`, `maxResults`), como o `normalize` do `runtime.ts`.
        assert_eq!(value["providers"], json!(["jackett"]));
        assert_eq!(value["maxResults"], json!(20));
        assert!(value.get("p").is_none());
    }

    #[test]
    fn decode_recusa_lixo() {
        let too_long = "a".repeat(MAX_CONFIG_SEGMENT + 1);
        for bad in ["", "não-é-base64url!!", "###", too_long.as_str()] {
            assert!(decode_user_config(bad).is_err(), "deveria recusar {bad:?}");
        }
        // Base64url de `[1,2]` e de `"texto"`: JSON válido, mas não é objeto —
        // mesmo critério do `decode` do Node.
        assert!(decode_user_config("WzEsMl0").is_err());
        assert!(decode_user_config("InRleHRvIg").is_err());
    }

    #[test]
    fn chave_estavel_por_config() {
        let a = json!({ "p": ["jackett"], "debridApiKey": "chave-a" });
        let b = json!({ "p": ["jackett"], "debridApiKey": "chave-a" });
        let key = request_cache_key("movie", "tt1", &a);
        assert_eq!(key, request_cache_key("movie", "tt1", &b));
        assert!(key.starts_with("streams:v21:movie:tt1:"));
        assert!(!key.contains("chave-a"));
        assert_eq!(key, adom_core::streams_cache_key("movie", "tt1", &a));
    }

    #[test]
    fn chave_muda_por_conta_e_por_config() {
        let conta_a = json!({ "p": ["jackett"], "debridApiKey": "chave-a" });
        let conta_b = json!({ "p": ["jackett"], "debridApiKey": "chave-b" });
        let outra_config = json!({ "p": ["demo"], "debridApiKey": "chave-a" });
        let base = request_cache_key("movie", "tt1", &conta_a);
        assert_ne!(base, request_cache_key("movie", "tt1", &conta_b));
        assert_ne!(base, request_cache_key("movie", "tt1", &outra_config));
        assert_ne!(base, request_cache_key("series", "tt1", &conta_a));
    }

    #[test]
    fn prazo_dart_versus_stremio() {
        assert_eq!(
            reply_deadline_ms(Some("Dart/3.4 (dart:io)"), 9200, 15000),
            15000
        );
        assert_eq!(reply_deadline_ms(Some("dart/3.4"), 9200, 15000), 15000);
        assert_eq!(reply_deadline_ms(Some("Stremio/1.6"), 9200, 15000), 9200);
        assert_eq!(reply_deadline_ms(None, 9200, 15000), 9200);
        // Prefixo, não substring: o app é o Dart puro, não um UA que o cita.
        assert_eq!(
            reply_deadline_ms(Some("Mozilla/5.0 Dart/3.4"), 9200, 15000),
            9200
        );
        assert_eq!(reply_deadline_ms(Some("Dart"), 9200, 15000), 9200);
        // Prefixo ASCII contra UA multibyte não pode entrar em pânico.
        assert_eq!(reply_deadline_ms(Some("Dárte/1.0"), 9200, 15000), 9200);
    }
}
