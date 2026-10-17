//! Forma do corpo JSON do `/stream` — o que o Stremio recebe.
//!
//! Derivado de `src/routes/stream.ts` (envelope `streams` + `cacheMaxAge`),
//! `src/routes/addon-router.ts` (serialização e `Cache-Control`) e do que o
//! construtor realmente emite: `src/utils/search-names.ts` (`name`, `title`,
//! `infoHash`, `sources`, `behaviorHints.bingeGroup`) e
//! `src/providers/stream-builder.ts` (`applyNoticeOrigin`: `externalUrl`,
//! `size` e remoção dos campos internos `_*`).
//!
//! Regras que valem para o porte:
//!
//! - **campos internos (`_br`, `_seeders`, `_fromFallback`, …) NUNCA saem**:
//!   `limitReservingBr` os remove e `applyNoticeOrigin` remove a marca `notice`;
//!   por isso eles não existem neste tipo;
//! - **`url` × `infoHash`**: item P2P leva `infoHash` (e `sources`); item
//!   resolvido pelo debrid leva `url` e perde `infoHash`/`sources`;
//! - **`externalUrl`** é o aviso de lista vazia; só existe se houver origin;
//! - **`size`** é o chip do app Power Movie, derivado do `💾` já presente no
//!   `title` na hora da resposta (o Stremio ignora o campo);
//! - **`cacheMaxAge`** é inteiro e SEMPRE presente (0 = precisa revalidar).
//!
//! A ordem das chaves do JSON do Node segue a ordem de construção do objeto e
//! varia por tipo de item (P2P × debrid × aviso). O contrato fixa a forma, não
//! a ordem: a métrica de sombra mascara ordem de lista e de chaves.
use serde::{Deserialize, Serialize};

/// `behaviorHints` do Stremio; o construtor só publica `bingeGroup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct BehaviorHints {
    /// Agrupa episódios da mesma release no autoplay do Stremio.
    #[serde(
        rename = "bingeGroup",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub binge_group: Option<String>,
}

/// Um item de `streams`. Todos os campos são opcionais porque cada variante
/// (P2P, debrid, aviso) usa um subconjunto — mas ao menos um de
/// `url`/`infoHash`/`externalUrl` precisa existir para o cliente renderizar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct StreamItem {
    /// Coluna estreita: marca + qualidade + seeders (`search-names.ts`).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    /// Release completa + marcadores (`👤`/`💾`/`⚙️`/`📦`).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
    /// btih de 40 hex; presente no item P2P e no pack multiobra.
    #[serde(rename = "infoHash", skip_serializing_if = "Option::is_none", default)]
    pub info_hash: Option<String>,
    /// Lista `tracker:<url>` do item P2P (só no item P2P).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sources: Option<Vec<String>>,
    #[serde(
        rename = "behaviorHints",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub behavior_hints: Option<BehaviorHints>,
    /// Link pronto do debrid (`/resolve/...` com host já montado na resposta).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub url: Option<String>,
    /// Aviso acionável — só o item de lista vazia tem; aponta para `/configure`.
    #[serde(
        rename = "externalUrl",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub external_url: Option<String>,
    /// Chip de tamanho lido do `💾` do `title` (campo do Power Movie).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub size: Option<String>,
}

/// Corpo do `/stream`. `streams` vem primeiro e `cacheMaxAge` depois, na mesma
/// ordem do `return` de `src/routes/stream.ts`.
///
/// Os campos `staleRevalidate`/`staleError` que o Node também devolve (quando
/// `cacheMaxAge > 0`) ainda NÃO estão modelados: ver a tabela de lacunas em
/// `docs/rust-stream-contract.md` §10.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct StreamResponse {
    pub streams: Vec<StreamItem>,
    #[serde(rename = "cacheMaxAge")]
    pub cache_max_age: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Amostra derivada do construtor real: item P2P do `toStremioStream`
    /// (`search-names.ts:205-225`) já passado por `limitReservingBr` (sem
    /// campos `_*`). Sem debrid não há `url`; `sources` é a lista de trackers.
    fn sample_p2p() -> StreamResponse {
        StreamResponse {
            streams: vec![StreamItem {
                name: Some("[Fake] Filme Teste (2024) 1080p WEB-DL Dublado".to_string()),
                title: Some(
                    "Filme Teste 2024 1080p WEB-DL x264 DUBLADO\n👤 10 💾 1.50 GB ⚙️ FakeTracker"
                        .to_string(),
                ),
                info_hash: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
                sources: Some(vec![
                    "tracker:udp://tracker.opentrackr.org:1337/announce".to_string()
                ]),
                behavior_hints: Some(BehaviorHints {
                    binge_group: Some("powerm-1080p-web-dl".to_string()),
                }),
                url: None,
                external_url: None,
                size: None,
            }],
            cache_max_age: 900,
        }
    }

    #[test]
    fn json_do_item_p2p_e_igual_ao_do_node() {
        // Ordem de chaves idêntica à do objeto do Node nesta variante
        // (name, title, infoHash, sources, behaviorHints) e `cacheMaxAge` por
        // último: é o que garante "byte a byte" quando não há `url`.
        let expected = concat!(
            r#"{"streams":[{"name":"[Fake] Filme Teste (2024) 1080p WEB-DL Dublado","#,
            r#""title":"Filme Teste 2024 1080p WEB-DL x264 DUBLADO\n👤 10 💾 1.50 GB ⚙️ FakeTracker","#,
            r#""infoHash":"0123456789abcdef0123456789abcdef01234567","#,
            r#""sources":["tracker:udp://tracker.opentrackr.org:1337/announce"],"#,
            r#""behaviorHints":{"bingeGroup":"powerm-1080p-web-dl"}}],"#,
            r#""cacheMaxAge":900}"#,
        );
        assert_eq!(serde_json::to_string(&sample_p2p()).unwrap(), expected);
    }

    #[test]
    fn json_do_aviso_e_igual_ao_do_node() {
        // Aviso de lista vazia: `buildStreams` cria só `{name, notice}`;
        // `applyNoticeOrigin` troca a marca pelo `externalUrl` com o host da
        // requisição (o cache guarda o path relativo, a resposta não).
        let response = StreamResponse {
            streams: vec![StreamItem {
                name: Some(
                    "Nada pronto ainda — procurando a temporada; reabra em instantes".to_string(),
                ),
                external_url: Some(
                    "http://127.0.0.1:7000/eyJwIjoiamFja2V0dCJ9/configure".to_string(),
                ),
                ..StreamItem::default()
            }],
            cache_max_age: 0,
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            concat!(
                r#"{"streams":[{"name":"Nada pronto ainda — procurando a temporada; reabra em instantes","#,
                r#""externalUrl":"http://127.0.0.1:7000/eyJwIjoiamFja2V0dCJ9/configure"}],"#,
                r#""cacheMaxAge":0}"#,
            ),
        );
    }

    #[test]
    fn json_do_item_debrid_leva_url_antes_do_size() {
        // `viaDebrid` apaga `infoHash`/`sources` e acrescenta `url`;
        // `applyNoticeOrigin` acrescenta `size` por último. O struct reproduz
        // essa ordem.
        let response = StreamResponse {
            streams: vec![StreamItem {
                name: Some("[AD⚡] Filme Teste (2024) 1080p".to_string()),
                title: Some("Filme Teste 2024 1080p WEB-DL DUBLADO\n👤 10 💾 1.50 GB ⚙️ FakeTracker".to_string()),
                behavior_hints: Some(BehaviorHints {
                    binge_group: Some("powerm-1080p-web-dl".to_string()),
                }),
                url: Some("http://127.0.0.1:7000/eyJwIjoiamFja2V0dCJ9/resolve/0123456789abcdef0123456789abcdef01234567?sig=deadbeef".to_string()),
                size: Some("1.50 GB".to_string()),
                ..StreamItem::default()
            }],
            cache_max_age: 900,
        };
        let json = serde_json::to_string(&response).unwrap();
        let url_at = json.find("\"url\"").expect("url no JSON");
        let size_at = json.find("\"size\"").expect("size no JSON");
        assert!(url_at < size_at, "url deve preceder size: {json}");
    }

    #[test]
    fn round_trip_preserva_o_corpo() {
        let response = sample_p2p();
        let json = serde_json::to_string(&response).unwrap();
        let back: StreamResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(back, response);
    }

    #[test]
    fn campos_internos_sao_ignorados_na_leitura() {
        // O cache/Node pode carregar marcas internas; o contrato não as expõe.
        let node_body = concat!(
            r#"{"streams":[{"name":"X","infoHash":"0123456789abcdef0123456789abcdef01234567","#,
            r#""_br":true,"_seeders":10,"_fromFallback":true}],"cacheMaxAge":0}"#,
        );
        let parsed: StreamResponse = serde_json::from_str(node_body).unwrap();
        assert_eq!(parsed.cache_max_age, 0);
        assert_eq!(parsed.streams.len(), 1);
        let out = serde_json::to_string(&parsed).unwrap();
        assert!(!out.contains("_br"));
        assert!(!out.contains("_seeders"));
    }
}
