//! Cascata de picks do autofetch BR — porte puro do restante de
//! `src/utils/autofetch-picks.ts` (o picking por faixa-alvo vive em
//! [`super::target`]). Submódulo de [`super`](crate::br_pool_selection).
//!
//! Assim como os pools, todas as funções aqui são ENTRADA→SAÍDA: recebem os
//! streams e as opções e devolvem índices/bools/conjuntos. Não leem config,
//! runtime, debrid, banco nem rede — a fronteira impura (o `Stream` real, o
//! `DebridAdapter`, o `dropTrace` que escreve no trace) fica no chamador.
//!
//! # `filter_known_cache` e o trace
//!
//! O TS chama `dropTrace(trace, stream, reason)` dentro do filtro (IO no
//! `StreamTraceState`). Aqui a filtragem é pura: o motivo de cada corte volta
//! em [`FilterKnownResult::dropped`] (índice + reason) e o chamador é quem
//! alimenta o trace, na ordem devolvida. Nada de callback/IO no núcleo.
//!
//! # `can_auto_fetch_br` e o adapter
//!
//! `canAutoFetchBr({autoFetchBr}, adapter)` lê `adapter.cacheCheck` e
//! `adapter.autofetchSource`. O adapter é impuro; aqui entram só os DOIS flags
//! já resolvidos pelo chamador — a regra (`toggle && (cacheCheck || fonte)`) é
//! o que se porta.

use std::collections::HashSet;

use crate::release_labels::source_from_title;

use super::{
    any_dubbed_pool, br_dubbed_pool, fallback_blocked, is_autofetch_target_quality,
    top_seeded_pool, PoolOptions, PoolStream,
};

/// `hashSet`: minúsculas e sem vazios, para o dedupe/cache case-insensitive.
///
/// O conjunto de cacheados é sempre minúsculo (o debrid normaliza na ida e os
/// adapters na volta), mas o `infoHash` do stream vem cru do Jackett — e o
/// Torznab devolve o btih em MAIÚSCULO. Comparar direto erra silencioso.
pub fn hash_set(hashes: &HashSet<String>) -> HashSet<String> {
    hashes
        .iter()
        .map(|h| h.to_lowercase())
        .filter(|h| !h.is_empty())
        .collect()
}

/// `pickFromPool`: até `limit` de um pool JÁ ordenado (a ordem é a prioridade),
/// sem olhar resolução: dedupe de hash case-insensitive, pula o que está em
/// cache e para em `limit`. `cached` chega já normalizado por [`hash_set`].
/// Devolve os índices do `streams` original.
pub fn pick_from_pool(
    streams: &[PoolStream],
    pool: &[usize],
    cached: &HashSet<String>,
    limit: i64,
) -> Vec<usize> {
    let max = limit.max(0);
    if max == 0 {
        return Vec::new();
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<usize> = Vec::new();
    for &i in pool {
        let s = &streams[i];
        if !s.has_hash() {
            continue;
        }
        let key = s.hash_key();
        if seen.contains(&key) || cached.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(i);
        if out.len() as i64 >= max {
            break;
        }
    }
    out
}

/// `pickBrDubbedCandidates`: melhores BR dublados para o autofetch — o pool
/// `brDubbedPool` já ordena por marca de áudio, pack, resolução e seeders.
pub fn pick_br_dubbed_candidates(
    streams: &[PoolStream],
    cached_hashes: &HashSet<String>,
    limit: i64,
    opts: &PoolOptions,
) -> Vec<usize> {
    let pool = br_dubbed_pool(streams, opts);
    let cached = hash_set(cached_hashes);
    pick_from_pool(streams, &pool, &cached, limit)
}

/// `pickBrDubbedCandidate`: compatibilidade — o melhor BR dublado (ou `None`).
pub fn pick_br_dubbed_candidate(
    streams: &[PoolStream],
    cached_hashes: &HashSet<String>,
) -> Option<usize> {
    pick_br_dubbed_candidates(streams, cached_hashes, 1, &PoolOptions::default())
        .first()
        .copied()
}

/// `pickAnyDubbedCandidates`: candidatos do fallback global (mesmas regras do
/// pick BR, sobre `anyDubbedPool`).
pub fn pick_any_dubbed_candidates(
    streams: &[PoolStream],
    cached_hashes: &HashSet<String>,
    limit: i64,
    opts: &PoolOptions,
) -> Vec<usize> {
    let pool = any_dubbed_pool(streams, opts);
    let cached = hash_set(cached_hashes);
    pick_from_pool(streams, &pool, &cached, limit)
}

/// `pickTopSeededCandidates`: rede de segurança do swarm (sobre `topSeededPool`).
pub fn pick_top_seeded_candidates(
    streams: &[PoolStream],
    cached_hashes: &HashSet<String>,
    limit: i64,
    opts: &PoolOptions,
) -> Vec<usize> {
    let pool = top_seeded_pool(streams, opts);
    let cached = hash_set(cached_hashes);
    pick_from_pool(streams, &pool, &cached, limit)
}

/// `hasCachedBrDubbed`: já existe fonte BR dublada tocável? Diagnóstico e
/// fallback do ramo sem qualidade-alvo. NÃO bloqueia upgrade (o stop com alvos
/// usa [`cached_br_dubbed_target_qualities`]). Pool com opções default.
pub fn has_cached_br_dubbed(streams: &[PoolStream], cached_hashes: &HashSet<String>) -> bool {
    let cached = hash_set(cached_hashes);
    br_dubbed_pool(streams, &PoolOptions::default())
        .iter()
        .any(|&i| cached.contains(&streams[i].hash_key()))
}

/// `hasCachedAnyDubbed`: dublado global (`_dubbed`) já tocável — o ⚡ gringo sem
/// marca não conta. Pool com opções default.
pub fn has_cached_any_dubbed(streams: &[PoolStream], cached_hashes: &HashSet<String>) -> bool {
    let cached = hash_set(cached_hashes);
    any_dubbed_pool(streams, &PoolOptions::default())
        .iter()
        .any(|&i| cached.contains(&streams[i].hash_key()))
}

/// `cachedBrDubbedTargetQualities`: faixas-alvo (720/1080/4K) do pool BR dublado
/// que JÁ estão em cache. Unknown/SD nunca entram — não contam como cobertura.
pub fn cached_br_dubbed_target_qualities(
    streams: &[PoolStream],
    cached_hashes: &HashSet<String>,
    opts: &PoolOptions,
) -> HashSet<String> {
    let cached = hash_set(cached_hashes);
    let mut covered: HashSet<String> = HashSet::new();
    for &i in &br_dubbed_pool(streams, opts) {
        let s = &streams[i];
        if !cached.contains(&s.hash_key()) {
            continue;
        }
        let q = s.quality_text();
        if is_autofetch_target_quality(&q) {
            covered.insert(q);
        }
    }
    covered
}

/// `canAutoFetchBr`: as travas reais são o toggle E (cacheCheck confiável OU
/// fonte de autofetch por inventário). `cachedOnly` não é mais trava.
pub fn can_auto_fetch_br(
    auto_fetch_br: bool,
    adapter_cache_check: bool,
    adapter_autofetch_source: bool,
) -> bool {
    auto_fetch_br && (adapter_cache_check || adapter_autofetch_source)
}

/// `brListableDubPool`: BR com áudio prometido ou provado — as vagas P2P do
/// `showUncachedBr`. Mesmo critério de áudio do `brDubbedPool` (prova, claim ou
/// banco), na ordem de entrada (SEM ordenar). LEGENDADO/origem sem claim fica
/// fora; claim precisa listar sob `d:1+bu`, senão a 1ª abertura some.
pub fn br_listable_dub_pool(streams: &[PoolStream]) -> Vec<usize> {
    streams
        .iter()
        .enumerate()
        .filter(|(_, s)| {
            s.has_hash()
                && !fallback_blocked(s)
                && s.is_br
                && !s.is_lied
                && (s.is_dubbed || s.is_dub_claim || s.is_bank_dub)
                && source_from_title(s.title_text()) != "CAM"
        })
        .map(|(i, _)| i)
        .collect()
}

/// `uncachedBrHashes`: exceção explícita ao cachedOnly — as vagas reservadas BR
/// que ainda não chegaram ao debrid continuam listando como torrent P2P (sem
/// selo ⚡). Prova primeiro, depois claim (ordenação estável por `_dubbed`);
/// LEGENDADO não ocupa vaga. Devolve os hashes NA CASCA ORIGINAL (o filtro
/// `visibleBr` do TS confere com `String(infoHash)` cru), em ordem de seleção.
pub fn uncached_br_hashes(
    streams: &[PoolStream],
    cached_hashes: &HashSet<String>,
    limit: i64,
) -> Vec<String> {
    let max = limit.max(0);
    let cached = hash_set(cached_hashes);
    let mut pool = br_listable_dub_pool(streams);
    // `.sort((a,b) => (b._dubbed?1:0) - (a._dubbed?1:0))`: estável, prova antes.
    pool.sort_by(|&a, &b| i64::from(streams[b].is_dubbed).cmp(&i64::from(streams[a].is_dubbed)));
    let mut selected: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for &i in &pool {
        if selected.len() as i64 >= max {
            break;
        }
        let s = &streams[i];
        if cached.contains(&s.hash_key()) {
            continue;
        }
        let original = s.info_hash.clone().unwrap_or_default();
        if seen.insert(original.clone()) {
            selected.push(original);
        }
    }
    selected
}

/// Opções de [`filter_known_cache`] (o objeto de configuração do TS).
#[derive(Debug, Clone)]
pub struct FilterKnownOptions {
    pub cached_only: bool,
    pub show_uncached_br: bool,
    pub br_reserved_slots: i64,
    pub known: bool,
    /// `missHashes`: recusa ternária do RD (ledger confirmou MISS/blocked).
    /// `None` = sem ledger; `Some` = o conjunto (normalizado por [`hash_set`]).
    pub miss_hashes: Option<HashSet<String>>,
}

impl Default for FilterKnownOptions {
    fn default() -> Self {
        Self {
            cached_only: true,
            show_uncached_br: false,
            br_reserved_slots: 0,
            known: true,
            miss_hashes: None,
        }
    }
}

/// Um corte do cachedOnly: o índice do stream e o motivo do `dropTrace` que o
/// chamador deve registrar (`"cached-only"` ou `"rd-miss"`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamDrop {
    pub index: usize,
    pub reason: &'static str,
}

/// Resultado de [`filter_known_cache`]: as vagas BR visíveis fora do cache, os
/// índices mantidos (na ordem) e os cortes com o motivo (para o trace).
#[derive(Debug, Clone)]
pub struct FilterKnownResult {
    /// Hashes BR na casca original que ocupam vaga P2P mesmo fora do cache, na
    /// ordem de seleção de [`uncached_br_hashes`] (o TS monta um `Set`, então
    /// a ordem não muda a regra — mas determinística é melhor para a ponte).
    pub visible_br: Vec<String>,
    pub kept: Vec<usize>,
    pub dropped: Vec<StreamDrop>,
}

/// `filterKnownCache`: o corte do cachedOnly. Mantém tudo com `cachedOnly:false`;
/// senão mantém o que está em cache ou ocupa vaga BR visível e, para o resto,
/// corta por `known` (conta respondeu completa → `"cached-only"`) ou por
/// `missHashes` (evidência do ledger → `"rd-miss"`). Sem `known` e sem miss,
/// o desconhecido sobrevive.
pub fn filter_known_cache(
    streams: &[PoolStream],
    cached_hashes: &HashSet<String>,
    opts: &FilterKnownOptions,
) -> FilterKnownResult {
    let cached = hash_set(cached_hashes);
    let miss = opts.miss_hashes.as_ref().map(hash_set);
    // Conta prova+claim já em cache: a vaga P2P é o que FALTA listar, não o que
    // o Chupim ainda vai baixar (só prova).
    let cached_br = br_listable_dub_pool(streams)
        .iter()
        .filter(|&&i| cached.contains(&streams[i].hash_key()))
        .count() as i64;
    let uncached_slots = (opts.br_reserved_slots - cached_br).max(0);
    // `Vec` (não `HashSet`): `uncached_br_hashes` já deduplica na casca
    // original e a ponte devolve a lista na ordem de seleção.
    let visible_br: Vec<String> = if opts.cached_only && opts.show_uncached_br {
        uncached_br_hashes(streams, &cached, uncached_slots)
    } else {
        Vec::new()
    };

    let mut kept: Vec<usize> = Vec::new();
    let mut dropped: Vec<StreamDrop> = Vec::new();
    for (i, s) in streams.iter().enumerate() {
        if !opts.cached_only {
            kept.push(i);
            continue;
        }
        let h = s.hash_key();
        // O TS confere a vaga com `String(infoHash)` cru (casca original).
        let original = s.info_hash.clone().unwrap_or_default();
        if cached.contains(&h) || visible_br.contains(&original) {
            kept.push(i);
            continue;
        }
        if opts.known {
            // P5 — corte do cachedOnly: hash fora do cache e conta completa.
            dropped.push(StreamDrop {
                index: i,
                reason: "cached-only",
            });
            continue;
        }
        if let Some(miss) = &miss {
            // P5 — recusa ternária do RD: o ledger confirmou MISS/blocked.
            if miss.contains(&h) {
                dropped.push(StreamDrop {
                    index: i,
                    reason: "rd-miss",
                });
                continue;
            }
        }
        kept.push(i);
    }
    FilterKnownResult {
        visible_br,
        kept,
        dropped,
    }
}
