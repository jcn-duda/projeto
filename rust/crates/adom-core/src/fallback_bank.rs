//! Regra PURA da reserva 📦 do banco de magnets para uma build.
//!
//! Porte da parte sem I/O de `collectFallbackItems`
//! (`src/providers/magnet-bank-fallback.ts`). A leitura do SQLite continua no
//! Node, por rota interna fina; aqui entram as linhas já lidas (obras, magnets
//! e fontes) e os FATOS do estado vivo, e sai a seleção com os mesmos cortes,
//! a mesma ordenação e os mesmos tetos do TS:
//!
//! - só indexer FALHO/PENDENTE entra; pendente no prazo conta como falho (o
//!   chamador já une os dois, como `failedIndexers()`);
//! - `all_failed` (ramo `/all` em erro/pendente) aceita qualquer fonte do banco;
//! - vazio suspeito (`suspect`) só cobre obra que já passou no filtro de título
//!   (`passed_filter == 1`) — não é falha provada;
//! - o hash do lote vivo vence sempre, antes dos tetos;
//! - a release precisa caber no episódio pedido (título/dn), com a MESMA régua
//!   de `releaseWork.ts`;
//! - `lied` e linha sem hash saem antes dos tetos;
//! - ordenação `passed_filter` desc, `seedersMax` desc, `last_seen` desc, com o
//!   teto por indexer e o global por ÚLTIMO (a linha que morreria no build não
//!   ocupa a vaga de outra).
//!
//! O item devolvido é o `RawItem` do `toRawItem` do TS: `fromFallback`, seeders
//! REAIS (`seedersLast`, o `~` é só exibição), `isBr` recalculado pela fonte BR
//! ou pelo título e `fallbackFetchable` quando `passed_filter == 1` ou a fonte
//! é index-only. `passed_filter` não é critério de elegibilidade no caminho de
//! falha: o item sempre refiltra no build; ele só ordena e libera o suspeito.

use std::collections::{BTreeMap, HashSet};

use crate::audio_presentation::looks_pt_br;
use crate::magnet_display_name::magnet_display_name;
use crate::release_work::{release_fits_request, WorkTarget};
use crate::search_bank::{pick_source, SourceRow};

/// Piso do teto por indexer (`PER_INDEXER_MAX` do TS).
pub const PER_INDEXER_MAX: i64 = 40;
/// Teto global do TS (`fallbackGlobalMax` clampado em 1..500).
pub const GLOBAL_MAX: i64 = 40;

/// Magnet já lido do banco (`MagnetRow`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FallbackMagnet {
    pub hash: String,
    pub uri: String,
    pub title: String,
    pub size: i64,
    pub is_br: bool,
    pub dubbed: bool,
    pub quality: String,
    pub seeders_max: i64,
    pub seeders_last: i64,
    pub last_seen: i64,
    pub lied: bool,
}

/// Obra do banco + o magnet dela (o `worksForObraMany` do Node).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FallbackWork {
    pub hash: String,
    pub passed_filter: i64,
    pub last_seen: i64,
    pub magnet: Option<FallbackMagnet>,
}

/// Fonte do hash (`magnet_source`), já com o veredito de seleção do pedido.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FallbackSource {
    pub indexer: String,
    pub tracker: String,
    pub last_seen: i64,
    /// `allowedSourceIndexer(indexer)` — index-only e fontes fora do `ji` já
    /// decididas no Node, onde o `opts()` da requisição existe.
    pub allowed: bool,
}

/// Entrada da decisão. Tudo que o TS lê de `config`, `LiveIndexerState`, da
/// obra e do banco vem por aqui; a função não abre arquivo, relógio nem rede.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FallbackInput {
    pub enabled: bool,
    pub fallback_enabled: bool,
    pub imdb_id: String,
    pub work_target: WorkTarget,
    pub live_hashes: HashSet<String>,
    /// `failedIndexers()` do Node: falhos + pendentes no prazo.
    pub failed: HashSet<String>,
    pub suspect: HashSet<String>,
    pub all_failed: bool,
    pub per_indexer_max: i64,
    pub global_max: i64,
    pub br_indexers: Vec<String>,
    pub index_only_indexers: Vec<String>,
    pub works: Vec<FallbackWork>,
    pub sources: BTreeMap<String, Vec<FallbackSource>>,
}

/// Item de reserva pronto para virar `RawItem`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FallbackItem {
    pub title: String,
    pub info_hash: String,
    pub magnet: Option<String>,
    pub size: Option<i64>,
    pub seeders: i64,
    pub indexer: String,
    pub tracker: String,
    pub is_br: bool,
    pub dubbed: bool,
    pub quality: String,
    pub fallback_fetchable: bool,
}

/// Resultado com os cortes contados (diagnóstico e testes).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FallbackResult {
    pub items: Vec<FallbackItem>,
    pub cut: BTreeMap<&'static str, usize>,
}

impl FallbackResult {
    pub fn injected(&self) -> usize {
        self.items.len()
    }
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

fn count(cut: &mut BTreeMap<&'static str, usize>, reason: &'static str) {
    *cut.entry(reason).or_insert(0) += 1;
}

fn limit_per_indexer(raw: i64) -> i64 {
    let value = if raw == 0 { PER_INDEXER_MAX } else { raw };
    value.clamp(1, PER_INDEXER_MAX)
}

fn limit_global(raw: i64) -> i64 {
    let value = if raw == 0 { GLOBAL_MAX } else { raw };
    value.clamp(1, 500)
}

/// Seleciona a reserva de UMA build. Fail-closed: entrada incompleta devolve
/// lista vazia, nunca inventa candidato.
pub fn collect_fallback(input: &FallbackInput) -> FallbackResult {
    let mut out = FallbackResult::default();
    if !input.enabled || !input.fallback_enabled {
        return out;
    }
    if !input.imdb_id.starts_with("tt") {
        return out;
    }
    if input.failed.is_empty() && !input.all_failed && input.suspect.is_empty() {
        return out;
    }

    let per_indexer_max = limit_per_indexer(input.per_indexer_max);
    let global_max = limit_global(input.global_max);
    let br_indexers: HashSet<String> = input.br_indexers.iter().map(|s| normalize(s)).collect();
    let index_only: HashSet<String> = input
        .index_only_indexers
        .iter()
        .map(|s| normalize(s))
        .collect();

    // 1. Magnets elegíveis, deduplicados por hash na ORDEM das linhas (a
    // primeira obra do hash vence, como o `Map` do TS).
    let mut magnets: Vec<&FallbackMagnet> = Vec::new();
    let mut works_by_hash: BTreeMap<&str, &FallbackWork> = BTreeMap::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for row in &input.works {
        let Some(magnet) = row.magnet.as_ref() else {
            count(&mut out.cut, "no-hash");
            continue;
        };
        if magnet.hash.is_empty() {
            count(&mut out.cut, "no-hash");
            continue;
        }
        if magnet.lied {
            count(&mut out.cut, "lied");
            continue;
        }
        let dn = magnet_display_name(Some(magnet.uri.as_str()), None, None);
        if !release_fits_request(input.work_target, &magnet.title, Some(dn.as_str())) {
            count(&mut out.cut, "episode-mismatch");
            continue;
        }
        if seen.insert(magnet.hash.as_str()) {
            magnets.push(magnet);
            works_by_hash.insert(magnet.hash.as_str(), row);
        }
    }

    // 2. Fonte elegível. `pick_source` recebe só as fontes permitidas; a
    // segunda passada (suspeito) usa o MESMO conjunto e exige passed_filter=1.
    let mut candidates = Vec::new();
    for magnet in magnets {
        let hash = magnet.hash.as_str();
        if input.live_hashes.contains(hash) {
            count(&mut out.cut, "live-dedupe");
            continue;
        }
        let all_sources = input.sources.get(hash).map(Vec::as_slice).unwrap_or(&[]);
        let allowed: Vec<&FallbackSource> = all_sources.iter().filter(|s| s.allowed).collect();
        let source_rows: Vec<SourceRow<'_>> = allowed
            .iter()
            .map(|s| SourceRow {
                indexer: s.indexer.as_str(),
                last_seen: s.last_seen,
            })
            .collect();
        let mut picked = pick_source(&source_rows, &input.failed, input.all_failed);
        let work = works_by_hash[hash];
        let mut from_suspect = false;
        if picked.is_none() && !input.suspect.is_empty() && work.passed_filter == 1 {
            picked = pick_source(&source_rows, &input.suspect, false);
            from_suspect = picked.is_some();
        }
        let Some(index) = picked else {
            count(&mut out.cut, "no-source");
            continue;
        };
        let source = allowed[index];
        let br_source = all_sources
            .iter()
            .any(|s| br_indexers.contains(&normalize(&s.indexer)));
        candidates.push((work, magnet, source, br_source, from_suspect));
    }

    // 3. Ordem do TS: passed_filter, seedersMax, lastSeen (estável).
    candidates.sort_by(|a, b| {
        b.0.passed_filter
            .cmp(&a.0.passed_filter)
            .then_with(|| b.1.seeders_max.cmp(&a.1.seeders_max))
            .then_with(|| b.1.last_seen.cmp(&a.1.last_seen))
    });

    // 4. Tetos por ÚLTIMO: o que morreria no build não ocupa vaga.
    let mut per_indexer: BTreeMap<String, i64> = BTreeMap::new();
    for (work, magnet, source, br_source, _suspect) in candidates {
        if out.items.len() as i64 >= global_max {
            count(&mut out.cut, "cap-global");
            continue;
        }
        let indexer_id = {
            let id = normalize(&source.indexer);
            if id.is_empty() {
                "unknown".to_string()
            } else {
                id
            }
        };
        let used = per_indexer.get(&indexer_id).copied().unwrap_or(0);
        if used >= per_indexer_max {
            count(&mut out.cut, "cap-indexer");
            continue;
        }
        per_indexer.insert(indexer_id, used + 1);
        out.items.push(FallbackItem {
            title: if magnet.title.is_empty() {
                "Torrent".to_string()
            } else {
                magnet.title.clone()
            },
            info_hash: magnet.hash.clone(),
            magnet: magnet
                .uri
                .starts_with("magnet:")
                .then(|| magnet.uri.clone()),
            size: (magnet.size > 0).then_some(magnet.size),
            seeders: magnet.seeders_last,
            indexer: source.indexer.clone(),
            tracker: source.tracker.clone(),
            is_br: br_source || looks_pt_br(&magnet.title),
            dubbed: magnet.dubbed,
            quality: magnet.quality.clone(),
            fallback_fetchable: work.passed_filter == 1
                || index_only.contains(&normalize(&source.indexer)),
        });
    }

    out
}

#[cfg(test)]
#[path = "fallback_bank_tests_support.rs"]
mod tests_support;

#[cfg(test)]
#[path = "fallback_bank_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "fallback_bank_tests_caps.rs"]
mod tests_caps;
