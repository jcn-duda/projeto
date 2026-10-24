//! Regra PURA da seleção da via instantânea do banco de magnets.
//!
//! Porte da parte sem I/O do antigo `collectInstantItems`
//! (`src/providers/magnet-bank-instant.ts`, removido no R4): a leitura do SQLite
//! (`worksForObraMany`/`sourcesForMany`) e a janela adaptativa
//! (`adom_core::search_bank::instant_window`) ficam FORA; aqui entram as linhas
//! já lidas e os fatos da requisição, e saem os itens que o build consome com o
//! selo 📦 (`fromFallback` no item de fio).
//!
//! Regras preservadas do TS:
//!
//! - dedupe por hash mantendo o MAGNET da primeira linha e a OBRA "medida"
//!   (`passed_filter == 1`) quando alguma linha do hash já passou no filtro vivo;
//! - `lied` e linha sem hash/magnet saem antes de tudo;
//! - elegibilidade: `passed_filter == 1` OU fonte index-only (o só-colhedor
//!   nunca passa pela busca viva); a fonte ainda precisa ser permitida pela
//!   config do pedido (`allowed`);
//! - hash já no índice (`exclude_hashes`) não vira 📦 — o idx é evidência
//!   melhor;
//! - com `prefer_dubbed`, o dublado do acervo vem ANTES do teto: ordenar só por
//!   seeders deixava o global mais semeado ocupar a vaga e cortava o BR;
//! - ordenação `dubRank`, `seedersMax` desc, `lastSeen` desc (estável), depois
//!   teto por indexer e global (o global por último, como no TS).
//!
//! A cobertura (`idx_pool_covered`) e a reaplicação do filtro de título
//! (`filter_relevant_raw`) rodam no CHAMADOR: são as mesmas regras já portadas
//! e o chamador tem a config viva do pedido.

use std::collections::{BTreeMap, HashSet};

use crate::search_bank::{pick_source, SourceRow};

#[path = "instant_bank_keys.rs"]
mod keys;
#[path = "instant_bank_rank.rs"]
mod rank;

use keys::{limit_global, limit_per_indexer, normalize};
use rank::{dub_rank, instant_is_br};

/// `PER_INDEXER_MAX` do TS (piso do teto por indexer).
pub const INSTANT_PER_INDEXER_MAX: i64 = 40;
/// Teto global default do TS (`fallbackGlobalMax`).
pub const INSTANT_GLOBAL_MAX: i64 = 40;

/// Uma linha do acervo (`magnet`) como a seleção a lê.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantMagnet {
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

/// Obra do banco + o magnet dela (`magnet_work` + `magnet`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantWork {
    pub hash: String,
    pub passed_filter: i64,
    pub last_seen: i64,
    pub first_seen: i64,
    pub magnet: Option<InstantMagnet>,
}

/// Fonte do hash (`magnet_source`), já com o veredito de `allowedSourceIndexer`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantSource {
    pub indexer: String,
    pub tracker: String,
    pub last_seen: i64,
    pub allowed: bool,
}

/// Entrada da seleção. A janela adaptativa/`stale` é decidida antes (o chamador
/// tem o relógio e as linhas de TODOS os alvos) — aqui é só a escolha.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantInput {
    /// `passed_filter`/`index_only`/ordem são lidos daqui.
    pub works: Vec<InstantWork>,
    pub sources: BTreeMap<String, Vec<InstantSource>>,
    /// Hashes já presentes no índice (evidência melhor; não viram 📦).
    pub exclude_hashes: HashSet<String>,
    pub index_only_indexers: Vec<String>,
    pub prefer_dubbed: bool,
    /// `fallbackMaxPerIndexer` já clampado pelo chamador.
    pub per_indexer_max: i64,
    /// `fallbackGlobalMax` já clampado pelo chamador.
    pub global_max: i64,
}

/// Item da reserva instantânea, na forma do `toRawItem` do TS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstantItem {
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

/// Resultado da seleção (sem filtro de título/cobertura, que são do chamador).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InstantSelection {
    pub items: Vec<InstantItem>,
    /// Quantos hashes já indexados foram excluídos (métrica `skip.idx-hash`).
    pub idx_hash_skipped: usize,
}

fn to_item(
    magnet: &InstantMagnet,
    source: &InstantSource,
    work: &InstantWork,
    index_only: &HashSet<String>,
) -> InstantItem {
    let uri = magnet.uri.as_str();
    let indexer_id = normalize(&source.indexer);
    let fetchable = work.passed_filter == 1 || index_only.contains(&indexer_id);
    InstantItem {
        title: if magnet.title.is_empty() {
            "Torrent".to_string()
        } else {
            magnet.title.clone()
        },
        info_hash: magnet.hash.clone(),
        magnet: uri.starts_with("magnet:").then(|| uri.to_string()),
        size: (magnet.size > 0).then_some(magnet.size),
        seeders: magnet.seeders_last,
        indexer: source.indexer.clone(),
        tracker: source.tracker.clone(),
        is_br: instant_is_br(magnet),
        dubbed: magnet.dubbed,
        quality: magnet.quality.clone(),
        fallback_fetchable: fetchable,
    }
}

/// Seleciona a reserva instantânea. Lista vazia = nenhum candidato elegível; o
/// chamador conta o motivo (`no-live-collection` no TS) e segue ao vivo.
pub fn select_instant(input: &InstantInput) -> InstantSelection {
    let mut out = InstantSelection::default();
    let per_indexer_max = limit_per_indexer(input.per_indexer_max);
    let global_max = limit_global(input.global_max);
    let index_only: HashSet<String> = input
        .index_only_indexers
        .iter()
        .map(|id| normalize(id))
        .collect();

    // 1. Dedupe por hash na ORDEM das linhas. O magnet fica o primeiro; a obra
    //    pode ser trocada pela linha medida (`passed_filter == 1`), porque o
    //    MESMO magnet tem até três linhas (episódio/temporada/raiz) e o pack
    //    achado na busca do episódio pode estar `passed_filter=0` ali mesmo
    //    quando a busca da temporada o validou.
    let mut magnets: Vec<&InstantMagnet> = Vec::new();
    let mut works_by_hash: BTreeMap<&str, &InstantWork> = BTreeMap::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for row in &input.works {
        let Some(magnet) = row.magnet.as_ref() else {
            continue;
        };
        if magnet.hash.is_empty() {
            continue;
        }
        if magnet.lied {
            continue;
        }
        if !seen.insert(magnet.hash.as_str()) {
            if let Some(prior) = works_by_hash.get(magnet.hash.as_str()) {
                if prior.passed_filter != 1 && row.passed_filter == 1 {
                    works_by_hash.insert(magnet.hash.as_str(), row);
                }
            }
            continue;
        }
        magnets.push(magnet);
        works_by_hash.insert(magnet.hash.as_str(), row);
    }

    // 2. Candidatos: exclusão do idx, fonte permitida e elegibilidade.
    let mut candidates: Vec<(&InstantMagnet, &InstantSource, &InstantWork)> = Vec::new();
    for magnet in magnets {
        if input.exclude_hashes.contains(&magnet.hash) {
            out.idx_hash_skipped += 1;
            continue;
        }
        let all_sources = input
            .sources
            .get(&magnet.hash)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let allowed: Vec<&InstantSource> =
            all_sources.iter().filter(|source| source.allowed).collect();
        let work = works_by_hash[magnet.hash.as_str()];
        let eligible = work.passed_filter == 1
            || allowed
                .iter()
                .any(|source| index_only.contains(&normalize(&source.indexer)));
        if !eligible {
            continue;
        }
        // Sem "indexer falho" nesta via: qualquer source do banco vale; a mais
        // recente vence (`pick_source` com `all_failed`).
        let rows: Vec<SourceRow<'_>> = allowed
            .iter()
            .map(|source| SourceRow {
                indexer: source.indexer.as_str(),
                last_seen: source.last_seen,
            })
            .collect();
        let Some(index) = pick_source(&rows, &HashSet::new(), true) else {
            continue;
        };
        candidates.push((magnet, allowed[index], work));
    }

    // 3. Ordem do TS (estável): dublado, seedersMax, lastSeen.
    candidates.sort_by(|(ma, _, _), (mb, _, _)| {
        dub_rank(ma, input.prefer_dubbed)
            .cmp(&dub_rank(mb, input.prefer_dubbed))
            .then_with(|| mb.seeders_max.cmp(&ma.seeders_max))
            .then_with(|| mb.last_seen.cmp(&ma.last_seen))
    });

    // 4. Tetos por ÚLTIMO (o candidato que morreria no build não ocupa vaga).
    let mut per_indexer: BTreeMap<String, i64> = BTreeMap::new();
    for (magnet, source, work) in candidates {
        if out.items.len() as i64 >= global_max {
            break;
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
            continue;
        }
        per_indexer.insert(indexer_id, used + 1);
        out.items.push(to_item(magnet, source, work, &index_only));
    }
    out
}

#[cfg(test)]
#[path = "instant_bank_tests.rs"]
mod tests;
