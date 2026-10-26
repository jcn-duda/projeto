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
//! - **TTL flexível**: o store grava o TTL que vier da decisão
//!   (`commit_decision`: 900s para lista completa; min(cache_ttl, 60) para
//!   parcial ou sem debridKnown; reserva com min(cache_ttl, fallback_ttl));
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
use serde_json::Value;

use crate::contract::StreamItem;

/// Graça do stale-while-revalidate, default de `STREAM_STALE_GRACE_SECONDS`.
pub const STREAM_STALE_GRACE_SECONDS: u64 = 300;

/// Valor gravado sob `streams:v21` — o MESMO shape do TS: lista pronta +
/// `debridKnown` + metadados de completude.
///
/// `trace` e `searchMeta` fazem parte do valor do Node desde a P5: o
/// `/stream-trace.json` lê o ledger OFFLINE da entrada, e o `searchMeta`
/// (nomes+ano) é a matéria-prima do recompute de título sem refazer
/// Cinemeta/TMDB. A promoção tardia copia os dois (substitui a entrada
/// inteira) — sem os campos, a primeira build perderia o ledger.
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
    /// A lista é SÓ aviso (`onlyNotice`): o Stremio não pode cacheá-la.
    /// O TS carrega a marca `notice` em cada item; aqui ela é da ENTRADA —
    /// o aviso de lista vazia é um estado da lista, não do item. `applyNoticeOrigin`
    /// devolve a marca por item na resposta.
    #[serde(default)]
    pub notice: bool,
    /// Ledger da busca, já no formato do `/stream-trace.json`
    /// (`serializeTrace`). `None` = trace desligado/sem trace (o TS grava
    /// `null`).
    #[serde(default)]
    pub trace: Option<Value>,
    /// `{ names, year }` da obra — injeção do `/stream-trace.json` offline.
    #[serde(rename = "searchMeta", default)]
    pub search_meta: Option<Value>,
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

// A fence mora em `cache_fence` só pelo teto de linhas; o caminho público
// continua `crate::cache::{Fence, fence_valid, obra_of_key}`.
pub use crate::cache_fence::{fence_valid, obra_of_key, Fence};

/// Store do cache da busca. `now_ms` entra como parâmetro: a semântica de
/// prazo tem que ser testável sem relógio real.
pub trait SwrStore: Send + Sync {
    /// `getWithStale` do TS: fresco devolve `stale: false`; entre o TTL e
    /// `TTL + grace` devolve `stale: true` SEM apagar; além disso devolve
    /// `None` (e apaga, como o `forget` do `getWithStale`).
    fn get_with_stale(&self, key: &str, grace_seconds: u64, now_ms: u64) -> Option<StoreHit>;
    /// Grava a entrada com o TTL decidido pelo chamador (`commit_decision`).
    fn set(&self, key: &str, value: &StreamsEntry, ttl_seconds: u64, now_ms: u64);
    /// Escrita direta da revalidação/fundo (mesma política de TTL).
    fn forget(&self, key: &str);
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Geração atual da obra dona de `key`.
    fn fence_for_key(&self, key: &str) -> Fence;
    /// Leitura SWR **e** fence no mesmo instante. É este par que a busca leva
    /// até o commit: capturar antes/depois da leitura abriria a janela em que a
    /// invalidação passa despercebida.
    fn get_fenced(&self, key: &str, grace_seconds: u64, now_ms: u64) -> (Option<StoreHit>, Fence) {
        let fence = self.fence_for_key(key);
        (self.get_with_stale(key, grace_seconds, now_ms), fence)
    }
    /// Grava só se a geração capturada na leitura ainda vale. `false` NÃO é
    /// erro: é a corrida perdida de propósito (nada foi escrito).
    fn set_fenced(
        &self,
        key: &str,
        value: &StreamsEntry,
        ttl_seconds: u64,
        now_ms: u64,
        fence: Fence,
    ) -> bool;
}

/// Implementação em memória, para testes e para a fatia sem persistência.
///
/// Os contadores de geração moram no MESMO `Mutex` das entradas: `get_fenced`
/// lê lista e fence numa seção crítica só (o `StreamsStore` faz o mesmo com a
/// transação).
#[derive(Default)]
pub struct MemorySwrStore {
    inner: Mutex<MemoryState>,
}

#[derive(Default)]
struct MemoryState {
    records: HashMap<String, MemoryRecord>,
    /// Contador por obra — espelho de `streams_meta` no store SQL.
    obra_gen: HashMap<String, u64>,
    /// `gen:epoch`: a invalidação global.
    epoch: u64,
}

#[derive(Debug, Clone)]
struct MemoryRecord {
    value: StreamsEntry,
    /// Momento (ms) em que o TTL vence.
    expires_at_ms: u64,
}

impl MemoryState {
    fn fence_of(&self, key: &str) -> Fence {
        let obra = obra_of_key(key)
            .and_then(|obra| self.obra_gen.get(&obra).copied())
            .unwrap_or(0);
        Fence {
            obra,
            epoch: self.epoch,
        }
    }

    fn bump(&mut self, obra: &str) {
        let counter = self.obra_gen.entry(obra.to_string()).or_insert(0);
        *counter = counter.saturating_add(1);
    }

    fn insert(&mut self, key: &str, value: &StreamsEntry, ttl_seconds: u64, now_ms: u64) {
        self.records.insert(
            key.to_string(),
            MemoryRecord {
                value: value.clone(),
                expires_at_ms: now_ms.saturating_add(ttl_seconds.saturating_mul(1000)),
            },
        );
    }

    fn read(&mut self, key: &str, grace_seconds: u64, now_ms: u64) -> Option<StoreHit> {
        let (expires_at_ms, value) = {
            let record = self.records.get(key)?;
            (record.expires_at_ms, record.value.clone())
        };
        if now_ms > expires_at_ms {
            if now_ms > expires_at_ms + grace_seconds.saturating_mul(1000) {
                // Passou da graça: apaga, como o `forget` do `getWithStale` —
                // é justamente a entrada que o SWR NÃO quer mais servir.
                self.records.remove(key);
                return None;
            }
            return Some(StoreHit { value, stale: true });
        }
        Some(StoreHit {
            value,
            stale: false,
        })
    }
}

impl MemorySwrStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mesma semântica do `StreamsStore::invalidate_for_obra` (T1-C1): anda a
    /// geração das DUAS kinds — a chave pode ainda NÃO existir (quem vai
    /// criá-la é a busca em voo, e é ela que precisa perder a corrida) — e
    /// apaga as listas da obra.
    pub fn invalidate_for_obra(&self, imdb_id: &str) {
        let movie = format!("movie:{imdb_id}");
        let series = format!("series:{imdb_id}");
        let mut state = self.inner.lock().expect("store envenenado");
        state.bump(&movie);
        state.bump(&series);
        state.records.retain(|key, _| match obra_of_key(key) {
            Some(obra) => obra != movie && obra != series,
            None => true,
        });
    }

    /// `clear_all` do store SQL: o epoch anda e TODAS as listas caem.
    pub fn clear_all(&self) {
        let mut state = self.inner.lock().expect("store envenenado");
        state.records.clear();
        state.epoch = state.epoch.saturating_add(1);
    }
}

impl SwrStore for MemorySwrStore {
    fn get_with_stale(&self, key: &str, grace_seconds: u64, now_ms: u64) -> Option<StoreHit> {
        self.inner
            .lock()
            .expect("store envenenado")
            .read(key, grace_seconds, now_ms)
    }

    fn set(&self, key: &str, value: &StreamsEntry, ttl_seconds: u64, now_ms: u64) {
        self.inner
            .lock()
            .expect("store envenenado")
            .insert(key, value, ttl_seconds, now_ms);
    }

    fn forget(&self, key: &str) {
        self.inner
            .lock()
            .expect("store envenenado")
            .records
            .remove(key);
    }

    fn len(&self) -> usize {
        self.inner.lock().expect("store envenenado").records.len()
    }

    fn fence_for_key(&self, key: &str) -> Fence {
        self.inner.lock().expect("store envenenado").fence_of(key)
    }

    fn get_fenced(&self, key: &str, grace_seconds: u64, now_ms: u64) -> (Option<StoreHit>, Fence) {
        let mut state = self.inner.lock().expect("store envenenado");
        let fence = state.fence_of(key);
        (state.read(key, grace_seconds, now_ms), fence)
    }

    fn set_fenced(
        &self,
        key: &str,
        value: &StreamsEntry,
        ttl_seconds: u64,
        now_ms: u64,
        fence: Fence,
    ) -> bool {
        let mut state = self.inner.lock().expect("store envenenado");
        if !fence_valid(fence, state.fence_of(key)) {
            return false;
        }
        state.insert(key, value, ttl_seconds, now_ms);
        true
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
#[path = "cache_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "cache_fence_tests.rs"]
mod fence_tests;
