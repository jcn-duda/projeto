//! Porte de `sortAndLimit` (`src/utils/stream-ranking.ts`, linhas ~174-340) —
//! o coração do pipeline de busca: filtra, ordena e corta o pool pré-debrid.
//!
//! Mesmo contrato da Parte 2 (`stream_ranking_dedupe`): PURO, sem IO e sem
//! estado de trace mutável — os cortes voltam em `SortOutput::drops` (o TS
//! registra no `dropTrace`) e as métricas (`metrics.count`) não existem aqui;
//! quem chama aplica `waived_hashes` → `search.brDubbed.seedFloorWaived` e
//! `quality_relaxed` → `search.qualityFilter.relaxed`.
//!
//! Paridades ansiosas com o JS:
//! - `dedupeByHash` roda DENTRO (o TS passa o mesmo trace), e os drops do
//!   dedupe abrem o ledger.
//! - O piso de seeders tem waiver BR dublado (`_seedFloorWaived` viaja marcado
//!   no stream de saída, como no TS) — invariante 3 do AGENTS.md.
//! - `sort` do JS (estável desde ES2019) ↔ `sort_by` do Rust (estável): o
//!   comparador é a mesma cadeia, com empate preservando a ordem de entrada.
//! - O `instant` do TS é callback; aqui é `HashSet<String>` de hashes
//!   materializado pelo chamador.
//! - Saída remove `_seeders`/`_size` (o destruturing do TS) mantendo os demais
//!   campos internos — quem apaga o resto é `limitReservingBr`, depois.

mod quality_filter;

use std::collections::HashSet;

use serde_json::Value;

use crate::episode_parse::parse_title_season_episode;
use crate::indexer_priority::{compare_indexer_priority, priority_map};
use crate::pt_audio_guards::has_explicit_foreign_audio;
use crate::release_labels::source_from_title;
use crate::stream_quotas_extra::{
    select_quality_candidates, QualityLimits, SelectCandidatesOpts, StreamRef, UNKNOWN_QUALITY,
};
use crate::stream_ranking_dedupe::{dedupe_by_hash, DedupeInput};
use crate::stream_ranking_types::{RankingStream, TraceDrop};

pub use quality_filter::passes_quality_filter;

/// 2º parâmetro do `sortAndLimit` do TS, com os MESMOS defaults.
#[derive(Debug, Clone)]
pub struct SortOptions {
    pub min_seeders: f64,
    pub max_results: f64,
    pub quality_filter: Vec<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub prefer_dubbed: bool,
    /// Lido e descartado no TS (`void dubbedOnly`): presença de global/EN em
    /// cache não é cortada aqui — mantido só para espelhar o contrato.
    pub dubbed_only: bool,
    pub exclude_cam: bool,
    pub max_size_gb: f64,
    pub quality_limits: QualityLimits,
    pub br_reserved_slots: f64,
    pub br_reserved_per_quality: f64,
    pub candidate_factor: f64,
    pub br_first: bool,
    pub indexer_priority: Vec<String>,
}

impl Default for SortOptions {
    fn default() -> Self {
        Self {
            min_seeders: 0.0,
            max_results: 40.0,
            quality_filter: Vec::new(),
            season: None,
            episode: None,
            prefer_dubbed: false,
            dubbed_only: false,
            exclude_cam: false,
            max_size_gb: 0.0,
            quality_limits: QualityLimits::default(),
            br_reserved_slots: 0.0,
            br_reserved_per_quality: 0.0,
            candidate_factor: 1.0,
            br_first: true,
            indexer_priority: Vec::new(),
        }
    }
}

/// Entrada do `sortAndLimit`. `streams` já aceita `null` no TS; aqui quem
/// filtra nulos é o dedupe (chave `infoHash` ausente — ver `Parte 2`).
#[derive(Debug, Clone, Default)]
pub struct SortInput {
    pub streams: Vec<RankingStream>,
    pub options: SortOptions,
    /// Callback `instant: (hash) => bool` do TS, materializado.
    pub instant_hashes: HashSet<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SortOutput {
    pub streams: Vec<RankingStream>,
    /// Streams com waiver do piso (`_seedFloorWaived`): quem chama aplica
    /// `metrics.count('search.brDubbed.seedFloorWaived')`.
    pub waived_hashes: Vec<String>,
    /// Último recurso do qualityFilter acionado
    /// (`metrics.count('search.qualityFilter.relaxed')` no TS).
    pub quality_relaxed: bool,
    /// Cortes na ordem do trace TS (`dedupe`, `lie`, `min-seeders`,
    /// `quality-filter`, `cam-excluded`, `size-limit`, `pool-cut`).
    pub drops: Vec<TraceDrop>,
}

/// `Boolean(x)` sobre selo tipado: `None` é `undefined`.
fn bool_of(v: Option<bool>) -> bool {
    v.unwrap_or(false)
}

/// `(s._seeders || 0)`.
fn num_or_zero(v: Option<f64>) -> f64 {
    v.filter(|n| n.is_finite()).unwrap_or(0.0)
}

fn first_line(text: &str) -> String {
    text.split('\n').next().unwrap_or("").to_string()
}

/// `String(s.title || s.name || '').split('\n')[0]`.
fn title_line(s: &RankingStream) -> String {
    let title = s.title.as_deref().filter(|t| !t.is_empty());
    let text = title.unwrap_or_else(|| s.name.as_deref().unwrap_or(""));
    first_line(text)
}

/// Cortado no formato do `dropTrace` (sem o `id` posicional do trace).
fn trace_drop_of(s: &RankingStream, reason: &str) -> TraceDrop {
    // `raw._br ?? raw.isBr` (nullish): `Some(false)` presente vence.
    let br =
        s.br.unwrap_or_else(|| matches!(s.extra.get("isBr"), Some(Value::Bool(true))));
    TraceDrop {
        reason: reason.to_string(),
        label: title_line(s),
        br,
        dubbed: s.dubbed,
        quality: s.quality.clone().filter(|q| !q.is_empty()),
    }
}

/// A visão `StreamRef` que as cotas leem: `streamQuality` usa
/// `s._quality || qualityFromTitle(s.title || s.name || '')`.
fn stream_ref_of(s: &RankingStream) -> StreamRef {
    StreamRef {
        title: s
            .title
            .clone()
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| s.name.clone().unwrap_or_default()),
        quality: s.quality.clone(),
        indexer: s.indexer.clone(),
        is_br: bool_of(s.br),
        is_dubbed: bool_of(s.dubbed),
        is_dub_claim: bool_of(s.dub_claim),
        is_lied: bool_of(s.lied),
        is_season_pack: false,
    }
}

/// Piso dispensado: BR com promessa ou prova de dublado, sem mentira e sem
/// idioma estrangeiro explícito. Não afrouxa para Dual ambíguo nem global.
fn is_proven_br_dubbed(s: &RankingStream) -> bool {
    bool_of(s.br)
        && (bool_of(s.dubbed) || bool_of(s.dub_claim))
        && !bool_of(s.lied)
        && !has_explicit_foreign_audio(&title_line(s))
}

/// `!excludeCam || (sourceFromTitle(s.title) !== 'CAM' &&
/// sourceFromTitle(s._magnetDn || '') !== 'CAM')` — o dn= do magnet é a prova
/// do arquivo real quando o título do post esconde a gravação.
fn not_cam(s: &RankingStream, exclude_cam: bool) -> bool {
    if !exclude_cam {
        return true;
    }
    source_from_title(&s.title.clone().unwrap_or_default()) != "CAM"
        && source_from_title(s.magnet_dn.as_deref().unwrap_or("")) != "CAM"
}

/// Tamanho ausente não é zero real: sem dado confiável o stream segue visível.
fn fits_size(s: &RankingStream, max_size_bytes: f64) -> bool {
    max_size_bytes == 0.0
        || s.size
            .filter(|n| n.is_finite())
            .is_none_or(|n| n <= max_size_bytes)
}

/// `qOrder` do comparador: sem resolução entre 720p e 480p (WEB-DL BR que não
/// anuncia resolução), chave desconhecida vale 0.
fn quality_rank(q: Option<&str>) -> i32 {
    match q {
        Some("2160p") => 5,
        Some("1080p") => 4,
        Some("720p") => 3,
        Some(q) if q == UNKNOWN_QUALITY => 2,
        Some("480p") => 1,
        Some("SD") => 0,
        _ => 0,
    }
}

pub fn sort_and_limit(input: &SortInput) -> SortOutput {
    let opts = &input.options;
    let max_size_bytes = if opts.max_size_gb > 0.0 {
        opts.max_size_gb * 1024.0 * 1024.0 * 1024.0
    } else {
        0.0
    };
    let ids: Vec<Option<&str>> = opts
        .indexer_priority
        .iter()
        .map(|s| Some(s.as_str()))
        .collect();
    let ranks = priority_map(&ids);
    let mut drops: Vec<TraceDrop> = Vec::new();

    // 1) nulos fora + mesma hash de vários indexers fundida (mesmo trace).
    let dd = dedupe_by_hash(&DedupeInput {
        streams: input.streams.clone(),
        indexer_priority: opts.indexer_priority.clone(),
    });
    drops.extend(dd.drops);

    struct Cand {
        s: RankingStream,
        r: StreamRef,
        id: usize,
        exact: u8,
    }
    let season_episode = opts.season.is_some() && opts.episode.is_some();
    let mut cands: Vec<Cand> = dd
        .streams
        .into_iter()
        .enumerate()
        .map(|(id, s)| {
            // Release que nomeia o episódio pedido vem antes do pack: marcado
            // uma vez, fora do comparador (o TS faz o mesmo por custo).
            let exact = if season_episode {
                let title = s.title.as_deref().unwrap_or("");
                u8::from(
                    parse_title_season_episode(title)
                        .episodes
                        .contains(&opts.episode.unwrap()),
                )
            } else {
                0
            };
            let r = stream_ref_of(&s);
            Cand { s, r, id, exact }
        })
        .collect();

    // 2) Mentiroso NUNCA entra (applyDebrid também corta; aqui é cedo).
    cands.retain(|c| {
        if bool_of(c.s.lied) {
            drops.push(trace_drop_of(&c.s, "lie"));
            false
        } else {
            true
        }
    });

    // 3) Piso de seeders com waiver BR dublado (invariante 3): em debrid com
    //    cache a release toca sem swarm — se morresse aqui, a checagem nunca
    //    mediria o hash. Não promove na ordenação; BAIXAR continua exigindo.
    let mut waived: HashSet<usize> = HashSet::new();
    cands = {
        let mut kept = Vec::with_capacity(cands.len());
        for c in cands {
            if num_or_zero(c.s.seeders) >= opts.min_seeders {
                kept.push(c);
            } else if is_proven_br_dubbed(&c.s) {
                waived.insert(c.id);
                kept.push(c);
            } else {
                drops.push(trace_drop_of(&c.s, "min-seeders"));
            }
        }
        kept
    };

    // 4) Whitelist de qualidade julga `_quality`, não substring do título. Se
    //    o conjunto permitido mata TODO mundo, reabre SD/480p/sem resolução
    //    (sem CAM e dentro do tamanho) como último recurso — gatilho é "vazio",
    //    não "fraco" (`_seeders` é sintético em agregador BR).
    let quality_ok = |c: &Cand| -> bool {
        let q = crate::stream_quotas_extra::stream_quality(&c.r);
        passes_quality_filter(
            &q,
            bool_of(c.s.br),
            &opts.quality_filter,
            &opts.quality_limits,
        )
    };
    let mut quality_keep: Option<HashSet<usize>> = None;
    let mut quality_relaxed = false;
    if !opts.quality_filter.is_empty() && !cands.iter().any(quality_ok) {
        let fallback: HashSet<usize> = cands
            .iter()
            .filter(|c| {
                let q = crate::stream_quotas_extra::stream_quality(&c.r);
                (q == "SD" || q == "480p" || q == UNKNOWN_QUALITY)
                    && not_cam(&c.s, opts.exclude_cam)
                    && fits_size(&c.s, max_size_bytes)
            })
            .map(|c| c.id)
            .collect();
        if !fallback.is_empty() {
            quality_keep = Some(fallback);
            quality_relaxed = true;
        }
    }
    cands.retain(|c| {
        let ok = match &quality_keep {
            Some(keep) => keep.contains(&c.id),
            None => quality_ok(c),
        };
        if ok {
            true
        } else {
            drops.push(trace_drop_of(&c.s, "quality-filter"));
            false
        }
    });
    cands.retain(|c| {
        if not_cam(&c.s, opts.exclude_cam) {
            true
        } else {
            drops.push(trace_drop_of(&c.s, "cam-excluded"));
            false
        }
    });
    cands.retain(|c| {
        if fits_size(&c.s, max_size_bytes) {
            true
        } else {
            drops.push(trace_drop_of(&c.s, "size-limit"));
            false
        }
    });

    // 5) Ordenação: episódio exato > qualidade > não-mentiroso > dublado
    //    (preferDubbed) > prioridade de indexer > instant > seeders. Estável.
    let instant = |c: &Cand| -> bool {
        c.s.info_hash
            .as_deref()
            .is_some_and(|h| input.instant_hashes.contains(h))
    };
    cands.sort_by(|a, b| {
        b.exact
            .cmp(&a.exact)
            .then_with(|| {
                quality_rank(b.s.quality.as_deref()).cmp(&quality_rank(a.s.quality.as_deref()))
            })
            .then_with(|| bool_of(a.s.lied).cmp(&bool_of(b.s.lied)))
            .then_with(|| {
                if opts.prefer_dubbed {
                    bool_of(b.s.dubbed).cmp(&bool_of(a.s.dubbed))
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .then_with(|| {
                // Sem prioridade configurada o TS devolve 0 (empate segue).
                let d = compare_indexer_priority(
                    a.s.indexer.as_deref(),
                    b.s.indexer.as_deref(),
                    &ranks,
                );
                d.cmp(&0)
            })
            .then_with(|| instant(b).cmp(&instant(a)))
            .then_with(|| {
                num_or_zero(b.s.seeders)
                    .partial_cmp(&num_or_zero(a.s.seeders))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    // 6) Pool ampliado (cotas por qualidade + reserva BR) e o corte que sobra
    //    vai ao trace como excedente, não como rejeição.
    let refs: Vec<&StreamRef> = cands.iter().map(|c| &c.r).collect();
    let sel = select_quality_candidates(
        &refs,
        &SelectCandidatesOpts {
            max_results: opts.max_results,
            quality_limits: opts.quality_limits.clone(),
            br_reserved_slots: opts.br_reserved_slots,
            br_reserved_per_quality: opts.br_reserved_per_quality,
            candidate_factor: opts.candidate_factor,
            br_first: opts.br_first,
        },
    );
    if sel.len() != cands.len() {
        // `sel` guarda POSIÇÕES na lista ordenada (`cands`), não os ids do dedupe.
        let vivos: HashSet<usize> = sel.iter().copied().collect();
        for (pos, c) in cands.iter().enumerate() {
            if !vivos.contains(&pos) {
                drops.push(trace_drop_of(&c.s, "pool-cut"));
            }
        }
    }

    let mut waived_hashes: Vec<String> = Vec::new();
    let streams = sel
        .into_iter()
        .map(|i| {
            let c = &cands[i];
            // `_seeders`/`_size` morrem aqui (destruturing do TS); os demais
            // `_*` sobrevivem até o `limitReservingBr` do chamador.
            let mut s = c.s.clone();
            s.seeders = None;
            s.size = None;
            if waived.contains(&c.id) {
                waived_hashes.push(s.info_hash.clone().unwrap_or_default());
                s.extra
                    .insert("_seedFloorWaived".to_string(), Value::Bool(true));
            }
            s
        })
        .collect();

    SortOutput {
        streams,
        waived_hashes,
        quality_relaxed,
        drops,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stream(hash: &str, name: &str, seeders: f64) -> RankingStream {
        serde_json::from_value(json!({
            "infoHash": hash, "name": name, "_seeders": seeders,
        }))
        .expect("stream de teste")
    }

    fn run(streams: Vec<RankingStream>, options: SortOptions) -> SortOutput {
        sort_and_limit(&SortInput {
            streams,
            options,
            instant_hashes: HashSet::new(),
        })
    }

    #[test]
    fn lista_vazia() {
        let out = run(vec![], SortOptions::default());
        assert!(out.streams.is_empty());
        assert!(out.drops.is_empty());
        assert!(!out.quality_relaxed);
    }

    #[test]
    fn piso_de_seeders_corta_e_waiver_br_dublado_salva() {
        let weak_br = serde_json::from_value::<RankingStream>(json!({
            "infoHash": "a".repeat(40), "name": "Filme DUBLADO", "_seeders": 0,
            "_br": true, "_dubbed": true,
        }))
        .unwrap();
        let weak_en = stream(&"b".repeat(40), "EN only", 0.0);
        let out = run(
            vec![weak_br, weak_en],
            SortOptions {
                min_seeders: 5.0,
                ..SortOptions::default()
            },
        );
        assert_eq!(out.streams.len(), 1);
        assert_eq!(out.streams[0].br, Some(true));
        assert_eq!(
            out.streams[0].extra.get("_seedFloorWaived"),
            Some(&Value::Bool(true))
        );
        assert_eq!(out.waived_hashes, vec!["a".repeat(40)]);
        assert_eq!(out.drops.len(), 1);
        assert_eq!(out.drops[0].reason, "min-seeders");
        assert_eq!(out.drops[0].label, "EN only");
    }

    #[test]
    fn ordena_por_qualidade_e_corta_no_max_results() {
        let mk = |name: &str, q: &str, seeds: f64| {
            serde_json::from_value::<RankingStream>(json!({
                "infoHash": name.repeat(4), "name": name,
                "_seeders": seeds, "_quality": q,
            }))
            .unwrap()
        };
        let options = SortOptions {
            max_results: 2.0,
            ..SortOptions::default()
        };
        let out = run(
            vec![
                mk("sd", "SD", 90.0),
                mk("fhd", "1080p", 1.0),
                mk("uhd", "2160p", 1.0),
            ],
            options,
        );
        assert_eq!(out.streams.len(), 2);
        assert_eq!(out.streams[0].quality.as_deref(), Some("2160p"));
        assert_eq!(out.streams[1].quality.as_deref(), Some("1080p"));
        assert_eq!(
            out.drops.last().map(|d| d.reason.as_str()),
            Some("pool-cut")
        );
        // `_seeders` sai da resposta (o TS o destrutura).
        assert_eq!(out.streams[0].seeders, None);
    }

    #[test]
    fn quality_filter_vazio_reabre_sd_como_ultimo_recurso() {
        let mk = |name: &str, q: &str, br: bool| {
            serde_json::from_value::<RankingStream>(json!({
                "infoHash": name.repeat(4), "name": name,
                "_seeders": 5, "_quality": q, "_br": br,
            }))
            .unwrap()
        };
        let options = SortOptions {
            quality_filter: vec!["1080p".to_string()],
            ..SortOptions::default()
        };
        let out = run(vec![mk("sd", "SD", true)], options);
        assert_eq!(out.streams.len(), 1);
        assert!(out.quality_relaxed);
    }

    #[test]
    fn prefer_dubbed_e_instant_desempatam_antes_de_seeders() {
        let mk = |name: &str, hash: String, seeds: f64, dubbed: bool| {
            serde_json::from_value::<RankingStream>(json!({
                "infoHash": hash, "name": name, "_seeders": seeds, "_dubbed": dubbed,
            }))
            .unwrap()
        };
        let mut instant_hashes = HashSet::new();
        instant_hashes.insert("c".repeat(40));
        let options = SortOptions {
            prefer_dubbed: true,
            ..SortOptions::default()
        };
        let out = sort_and_limit(&SortInput {
            streams: vec![
                mk("seeds", "d".repeat(40), 500.0, false),
                mk("dub", "a".repeat(40), 10.0, true),
                mk("instant", "c".repeat(40), 10.0, false),
            ],
            options,
            instant_hashes,
        });
        let names: Vec<_> = out
            .streams
            .iter()
            .map(|s| s.name.clone().unwrap())
            .collect();
        assert_eq!(names, vec!["dub", "instant", "seeds"]);
    }
}
