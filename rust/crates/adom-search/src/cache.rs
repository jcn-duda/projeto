//! Cache SWR da busca — porte do bloco de cache de
//! `src/providers/search-cache.ts` (oráculo: branch `esm`), no FORMATO
//! `streams:v21`.
//!
//! O que este módulo porta e o que fica para o orquestrador:
//!
//! - **valor** (`StreamsEntry`): a entrada gravada pelo `finish` é a lista
//!   PRONTA de streams + `debridKnown` + metadados de completude (`partial`,
//!   `fallback`), no mesmo shape do valor que o TS guarda sob
//!   `streamsCacheKey`. A chave em si é a de `request::request_cache_key`
//!   (config por usuário + digest da conta; o HOST NUNCA entra nela);
//! - **semântica SWR** (`swr_lookup`): só serve lista COMPLETA — `partial:
//!   false`, `debridKnown: true` e com stream TOCÁVEL (aviso `externalUrl` não
//!   conta; o teste é o mesmo `hasPlayableStream` do TS). Hit fresco serve sem
//!   revalidar; hit DENTRO da graça `STREAM_STALE_GRACE_SECONDS` (300 no
//!   `.env.example`) serve e sinaliza revalidação; incompleta NUNCA é servida.
//!   A régua de elegibilidade é `adom_core::stale_refresh_eligible` (a mesma do
//!   `search-commit.ts`), consumida aqui para os dois lados não divergirem;
//! - **TETO de 60s**: o store grampa qualquer TTL acima de
//!   [`MAX_TTL_SECONDS`], espelhando o "cache ≤ 60s" do fluxo de busca;
//! - **HOST NUNCA VAI PARA O CACHE** (`relative_url` + `to_cacheable_entry`):
//!   a URL de `/resolve` e o aviso (`externalUrl`) são gravados RELATIVOS — o
//!   `applyNoticeOrigin` do TS monta o host na resposta com o origin da
//!   requisição. Gravar absoluto vazaria o host de quem construiu a lista para
//!   outro leitor do cache.
//!
//! Nesta fatia o store é um trait com implementação em memória (testes); a
//! persistência SQLite do TS (`cache-db.ts`) é etapa de integração.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::contract::StreamItem;

/// Graça do stale-while-revalidate, default de `STREAM_STALE_GRACE_SECONDS`.
pub const STREAM_STALE_GRACE_SECONDS: u64 = 300;

/// Teto do TTL de qualquer entrada da busca ("cache ≤ 60s").
pub const MAX_TTL_SECONDS: u64 = 60;

/// Valor gravado sob `streams:v21` — o MESMO shape do TS: lista pronta +
/// `debridKnown` + metadados de completude.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct StreamsEntry {
    pub streams: Vec<StreamItem>,
    /// Parcial de COLETA (fontes lentas ainda não chegaram).
    #[serde(default)]
    pub partial: bool,
    /// `None` = a checagem no debrid nunca respondeu (estado REAL, como no TS).
    #[serde(rename = "debridKnown", default)]
    pub debrid_known: Option<bool>,
    /// A lista carrega reserva (fallback do banco ou foto 📦 do índice).
    #[serde(default)]
    pub fallback: bool,
}

/// `hasPlayableStream` do TS: a lista tem play de verdade — `url` ou
/// `infoHash`. O item de aviso carrega só `name` + `externalUrl` e NÃO conta.
pub fn has_playable_stream(streams: &[StreamItem]) -> bool {
    streams
        .iter()
        .any(|s| s.url.is_some() || s.info_hash.is_some())
}

/// Lista completa = coleta encerrada + debrid conferido + stream tocável.
/// É a condição de SERVIÇO do cache (fresco ou stale) — entrada incompleta
/// nunca é servida, nem fresca.
fn entry_complete(entry: &StreamsEntry) -> bool {
    !entry.partial && entry.debrid_known == Some(true) && has_playable_stream(&entry.streams)
}

/// Hit de leitura do store, espelho de `{ value, stale }` do `getWithStale`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreHit {
    pub value: StreamsEntry,
    /// `true` = expirou o TTL, mas está dentro da graça.
    pub stale: bool,
}

/// Store do cache da busca. `now_ms` entra como parâmetro: a semântica de
/// prazo tem que ser testável sem relógio real.
pub trait SwrStore: Send + Sync {
    /// `getWithStale` do TS: fresco devolve `stale: false`; entre o TTL e
    /// `TTL + grace` devolve `stale: true` SEM apagar; além disso devolve
    /// `None` (e apaga, como o `forget` do `getWithStale`).
    fn get_with_stale(&self, key: &str, grace_seconds: u64, now_ms: u64) -> Option<StoreHit>;
    /// Grava com o TTL GRAMPEADO a [`MAX_TTL_SECONDS`].
    fn set(&self, key: &str, value: &StreamsEntry, ttl_seconds: u64, now_ms: u64);
    /// Escrita direta da revalidação/fundo (mesma política de TTL).
    fn forget(&self, key: &str);
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Implementação em memória, para testes e para a fatia sem persistência.
#[derive(Default)]
pub struct MemorySwrStore {
    inner: Mutex<HashMap<String, MemoryRecord>>,
}

#[derive(Debug, Clone)]
struct MemoryRecord {
    value: StreamsEntry,
    /// Momento (ms) em que o TTL vence.
    expires_at_ms: u64,
}

impl MemorySwrStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SwrStore for MemorySwrStore {
    fn get_with_stale(&self, key: &str, grace_seconds: u64, now_ms: u64) -> Option<StoreHit> {
        let mut map = self.inner.lock().expect("store envenenado");
        let record = map.get(key)?;
        if now_ms > record.expires_at_ms {
            if now_ms > record.expires_at_ms + grace_seconds.saturating_mul(1000) {
                // Passou da graça: apaga, como o `forget` do `getWithStale` —
                // é justamente a entrada que o SWR NÃO quer mais servir.
                map.remove(key);
                return None;
            }
            return Some(StoreHit {
                value: record.value.clone(),
                stale: true,
            });
        }
        Some(StoreHit {
            value: record.value.clone(),
            stale: false,
        })
    }

    fn set(&self, key: &str, value: &StreamsEntry, ttl_seconds: u64, now_ms: u64) {
        // Cache ≤ 60s: teto estrutural, não política do chamador.
        let ttl = ttl_seconds.min(MAX_TTL_SECONDS);
        self.inner.lock().expect("store envenenado").insert(
            key.to_string(),
            MemoryRecord {
                value: value.clone(),
                expires_at_ms: now_ms.saturating_add(ttl.saturating_mul(1000)),
            },
        );
    }

    fn forget(&self, key: &str) {
        self.inner.lock().expect("store envenenado").remove(key);
    }

    fn len(&self) -> usize {
        self.inner.lock().expect("store envenenado").len()
    }
}

/// Resultado da consulta SWR pronta para o orquestrador.
#[derive(Debug, Clone, PartialEq)]
pub enum SwrLookup {
    /// Serve a entrada; `revalidate` liga o refresh de fundo (hit stale).
    Serve {
        entry: StreamsEntry,
        revalidate: bool,
    },
    /// Sem entrada servível: busca síncrona.
    Miss,
}

/// A decisão inteira do SWR em uma função: hit fresco completo serve sem
/// revalidar; hit stale DENTRO da graça serve só se elegível (completa +
/// tocável) e sinaliza revalidação; entrada incompleta NUNCA é servida.
pub fn swr_lookup(hit: Option<StoreHit>) -> SwrLookup {
    let Some(hit) = hit else {
        return SwrLookup::Miss;
    };
    if !entry_complete(&hit.value) {
        // Incompleta (parcial, sem debrid conferido ou só aviso) não estende
        // estado ruim nem fresca: cai na busca síncrona.
        return SwrLookup::Miss;
    }
    SwrLookup::Serve {
        entry: hit.value,
        revalidate: hit.stale,
    }
}

/// Deixa a URL RELATIVA para ir ao cache: corta `scheme://host` e fica só
/// caminho + query. É o análogo da regra do TS de gravar a URL de `/resolve` e
/// o aviso relativos (`applyNoticeOrigin` remonta o host na resposta, com o
/// origin da requisição). URL já relativa volta como está.
pub fn relative_url(url: &str) -> String {
    match url.find("://") {
        Some(start) => {
            let rest = &url[start + 3..];
            match rest.find('/') {
                Some(slash) => rest[slash..].to_string(),
                // `https://host` sem caminho: sem caminho não há endpoint.
                None => String::new(),
            }
        }
        None => url.to_string(),
    }
}

/// Ajusta a entrada para GRAVAÇÃO: `url` de `/resolve` e `externalUrl` do
/// aviso saem relativos. Nada mais muda — os campos internos de exibição já
/// são do contrato.
pub fn to_cacheable_entry(entry: &StreamsEntry) -> StreamsEntry {
    let mut out = entry.clone();
    for stream in &mut out.streams {
        if let Some(url) = &stream.url {
            stream.url = Some(relative_url(url));
        }
        if let Some(external) = &stream.external_url {
            stream.external_url = Some(relative_url(external));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn playable_item() -> StreamItem {
        StreamItem {
            info_hash: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
            ..StreamItem::default()
        }
    }

    fn notice_item() -> StreamItem {
        StreamItem {
            name: Some("Procurando fontes — reabra em instantes".to_string()),
            external_url: Some("https://host.example/configure".to_string()),
            ..StreamItem::default()
        }
    }

    fn complete_entry() -> StreamsEntry {
        StreamsEntry {
            streams: vec![playable_item()],
            partial: false,
            debrid_known: Some(true),
            fallback: false,
        }
    }

    #[test]
    fn hit_fresco_serve_sem_revalidar() {
        let store = MemorySwrStore::new();
        store.set("k", &complete_entry(), 60, 1_000);
        let hit = store
            .get_with_stale("k", STREAM_STALE_GRACE_SECONDS, 61_000)
            .expect("hit");
        assert!(!hit.stale);
        assert_eq!(
            swr_lookup(Some(hit)),
            SwrLookup::Serve {
                entry: complete_entry(),
                revalidate: false
            }
        );
    }

    #[test]
    fn hit_stale_serve_e_sinaliza_revalidacao() {
        let store = MemorySwrStore::new();
        store.set("k", &complete_entry(), 60, 1_000);
        // TTL 60s: vence em 61_000; dentro da graça de 300s até 361_000.
        let hit = store
            .get_with_stale("k", STREAM_STALE_GRACE_SECONDS, 200_000)
            .expect("hit stale");
        assert!(hit.stale);
        assert_eq!(
            swr_lookup(Some(hit)),
            SwrLookup::Serve {
                entry: complete_entry(),
                revalidate: true
            }
        );
        // Stale não apaga: leitura seguinte ainda encontra a entrada.
        assert!(store.get_with_stale("k", 300, 200_001).is_some());
    }

    #[test]
    fn miss_sem_entrada_e_depois_da_graca() {
        let store = MemorySwrStore::new();
        assert_eq!(swr_lookup(None), SwrLookup::Miss);
        store.set("k", &complete_entry(), 60, 1_000);
        // Um milissegundo além da graça: apaga e vira miss.
        assert_eq!(
            swr_lookup(store.get_with_stale("k", 300, 61_000 + 300_000 + 1)),
            SwrLookup::Miss
        );
        assert_eq!(store.len(), 0, "entrada além da graça deve ser apagada");
    }

    #[test]
    fn entrada_incompleta_nunca_e_servida() {
        // Parcial, sem debrid conferido e só aviso: nenhuma variação serve,
        // nem fresca (a lista sem stream tocável não estende estado ruim).
        let casos = vec![
            StreamsEntry {
                partial: true,
                ..complete_entry()
            },
            StreamsEntry {
                debrid_known: Some(false),
                ..complete_entry()
            },
            StreamsEntry {
                debrid_known: None,
                ..complete_entry()
            },
            StreamsEntry {
                streams: vec![notice_item()],
                ..complete_entry()
            },
            StreamsEntry {
                streams: vec![],
                ..complete_entry()
            },
        ];
        for entry in casos {
            store_check(&entry);
        }
    }

    fn store_check(entry: &StreamsEntry) {
        let store = MemorySwrStore::new();
        store.set("k", entry, 60, 1_000);
        assert_eq!(
            swr_lookup(store.get_with_stale("k", 300, 2_000)),
            SwrLookup::Miss
        );
        // Stale idem: elegibilidade exige completa + tocável dos dois lados.
        assert_eq!(
            swr_lookup(store.get_with_stale("k", 300, 200_000)),
            SwrLookup::Miss
        );
        // E a régua do núcleo (a mesma do search-commit.ts) concorda: o
        // `playable` vem do MESMO teste que o chamador usa (`hasPlayableStream`),
        // e aviso não conta como tocável.
        let json = serde_json::to_value(entry).unwrap();
        assert!(!adom_core::stale_refresh_eligible(
            Some(&json),
            has_playable_stream(&entry.streams)
        ));
    }

    #[test]
    fn expiracao_60s_teto_de_ttl() {
        let store = MemorySwrStore::new();
        // TTL pedido acima do teto: grampa em 60s.
        store.set("k", &complete_entry(), 900, 1_000);
        assert!(
            store.get_with_stale("k", 300, 1_000 + 61_000).is_some(),
            "aos 61s ainda está na graça"
        );
        let long_lived = StreamItem {
            url: Some("/resolve/x".to_string()),
            ..playable_item()
        };
        let entry = StreamsEntry {
            streams: vec![long_lived],
            ..complete_entry()
        };
        store.set("k2", &entry, 900, 1_000);
        // TTL grampiado em 60s: vence em 61_000. Com graça 0, o último ms
        // dentro do TTL serve e o primeiro depois não.
        assert!(store.get_with_stale("k2", 0, 1_000 + 60_000).is_some());
        assert!(store.get_with_stale("k2", 0, 1_000 + 60_001).is_none());
    }

    #[test]
    fn host_nunca_vai_para_o_cache() {
        let entry = StreamsEntry {
            streams: vec![
                StreamItem {
                    url: Some("https://meu-host.example/resolve/eyJhIjoxfQ/abc".to_string()),
                    ..playable_item()
                },
                notice_item(),
            ],
            ..complete_entry()
        };
        let gravada = to_cacheable_entry(&entry);
        let json = serde_json::to_value(&gravada).unwrap();
        let texto = json.to_string();
        assert!(!texto.contains("meu-host.example"), "host vazou: {texto}");
        assert_eq!(
            gravada.streams[0].url.as_deref(),
            Some("/resolve/eyJhIjoxfQ/abc")
        );
        assert_eq!(
            gravada.streams[1].external_url.as_deref(),
            Some("/configure")
        );
        // Forma do valor `streams:v21`: lista pronta + debridKnown + completude.
        assert_eq!(json["debridKnown"], json!(true));
        assert_eq!(json["partial"], json!(false));
        assert_eq!(json["fallback"], json!(false));
        assert!(json["streams"].is_array());
    }

    #[test]
    fn relative_url_casos_de_borda() {
        assert_eq!(relative_url("/resolve/x"), "/resolve/x");
        assert_eq!(relative_url("http://h.test/a?b=c"), "/a?b=c");
        assert_eq!(relative_url("https://h.test"), "");
    }

    #[test]
    fn chave_por_config_e_conta_reusada_do_request() {
        // A chave vem de `request_cache_key` (streamsCacheKey do TS): config +
        // digest da conta; nenhum pedaço de host e nenhuma credencial crua.
        let opts = json!({ "d": "1", "debridApiKey": "segredo" });
        let key = crate::request::request_cache_key("movie", "tt1", &opts);
        assert!(key.starts_with("streams:v21:movie:tt1:"));
        assert!(!key.contains("segredo"));
        assert!(!key.contains("http"));
    }
}
