//! BUILD da lista do `/stream` — porte da orquestração de
//! `stream-builder.ts` + `stream-builder-pipeline.ts` (oráculo: branch `esm`).
//!
//! Dos ITENS CRUS (saída da janela de coleta) até a LISTA FINAL, na ordem do
//! TS (as réguas são TODAS do `adom-core`; aqui é só sequência e estado):
//!
//! 1. entidades HTML saem do título (`decode_entities`) — a decisão não pode
//!    ver `&ordf;`;
//! 2. release falsa executável (`.exe` e hash gêmeo) sai antes de tudo;
//! 3. **filtro de título** (`adom_core::filter_relevant_raw`) — itens da conta
//!    pulam (já passaram pelo filtro deles no provider);
//! 4. **pack multiobra**: marcação (`admits_multi_work_pack`) e guarda de
//!    coleção (sem debrid/sem ano, pack retido);
//! 5. **episódio** (`adom_core::filter_series_episode`) com pré-air (margem
//!    48h sobre publish/first_seen) e unaired (margem 24h);
//! 6. **sortAndLimit** no POOL AMPLIADO (`max_results * candidatePoolFactor`),
//!    com piso de seeders sob `seedFloorFor` (invariante 3);
//! 7. **💾 de episódio** (`annotate_pack_sizes_core`/`annotate_movie_sizes_core`)
//!    — antes do debrid, como no TS;
//! 8. **applyDebrid** — [`DebridCheck`] (lote via `prepare`, depois por stream);
//! 9. **limitReservingBr** (corte final DEPOIS do pool ampliado, vagas BR por
//!    faixa);
//! 10. **aviso se vazia** (relativo, sem host) e conversão para o contrato.
//!
//! Fica para as próximas fatias: o index de releases (`releaseIndex.record`,
//! I/O) e o enriquecimento do magnet pelo banco (o caller injeta `dn=` via
//! `magnet`).

mod audio_proof;
// Seleção dos efeitos de cauda (dub_audit/warmer) sobre o lote pós-debrid.
mod effects;
mod finalize;
mod helpers;
mod stats;
#[cfg(test)]
mod tests;
#[cfg(test)]
#[path = "tests_bludv_br.rs"]
mod tests_bludv_br;
mod types;

pub use audio_proof::{apply_pt_title_dual, AudioAudit};
pub use effects::{AuditSeed, AutofetchItem, EffectSeeds, WarmerSeed};
use finalize::finalize_streams;

pub use types::{
    apply_notice_origin, seed_floor_for, BuildContext, BuildOptions, BuiltList, BuiltStream,
    DebridAnswer, DebridCheck, WorkHint,
};

use std::collections::BTreeSet;

use adom_core::{
    admits_multi_work_pack, annotate_movie_sizes_core, annotate_pack_sizes_core, decode_entities,
    filter_relevant_raw, filter_series_episode, is_multi_work_collection, normalize_title,
    sort_and_limit, PackOpts, RankingStream, RelevanceQuery, RelevanceSettings, SortInput,
    SortOptions, StreamDisplayConfig, WorkHint as DebridWorkHint,
};

use crate::raw_item::RawItem;
use helpers::*;

fn relevance_query(ctx: &BuildContext) -> RelevanceQuery<'_> {
    RelevanceQuery {
        names: &ctx.names,
        year: &ctx.year,
        alt_year: ctx.alt_year.as_deref(),
        is_series: ctx.season.is_some(),
        season: None,
        episode: None,
        multi_work_root: ctx.multi_work_root.as_deref(),
        // `matchContext.homeReleaseAt` do Node: o corte pré-home-release é do
        // filtro de título. Sem a data, `pre_home_release_contradicts` é
        // fail-open.
        home_release_at: ctx.home_release_at,
    }
}

fn relevance_settings(ctx: &BuildContext, opts: &BuildOptions) -> RelevanceSettings {
    RelevanceSettings {
        now_ms: ctx.now_ms,
        pre_home_release_cut: opts.pre_home_release_cut,
        pre_home_release_margin_ms: opts.pre_home_release_margin_ms,
        title_precision_tail_cut: opts.title_precision_tail_cut,
    }
}

/// Quantos itens passam no filtro de título — o `filterRelevantRaw` do
/// gatilho de pack do TS. Item da conta conta sempre, como no build.
pub fn relevant_count(raw: &[RawItem], ctx: &BuildContext, opts: &BuildOptions) -> usize {
    if ctx.names.is_empty() || ctx.is_demo {
        return raw.len();
    }
    let account = raw.iter().filter(|r| r.from_account).count();
    let rest: Vec<adom_core::RelevanceItem> = raw
        .iter()
        .filter(|r| !r.from_account)
        .map(RawItem::to_relevance)
        .collect();
    let kept = filter_relevant_raw(&rest, &relevance_query(ctx), &relevance_settings(ctx, opts));
    account + kept.kept.len()
}

/// Porte de `buildStreams(rawInput, …)` — síncrono porque toda I/O já chegou
/// como dado (`RawItem`, `BuildContext`) ou mora atrás da trait injetada.
pub fn build_stream_list(
    raw_input: &[RawItem],
    ctx: &BuildContext,
    opts: &BuildOptions,
    debrid: &mut dyn DebridCheck,
    display: &StreamDisplayConfig,
) -> BuiltList {
    let mut out = BuiltList::default();
    out.count("raw", raw_input.len());

    // 1. Entidades HTML saem AQUI, onde todas as origens já se juntaram.
    let mut raw: Vec<RawItem> = raw_input
        .iter()
        .map(|item| {
            let title = item.title_text();
            if !title.contains('&') {
                return item.clone();
            }
            let limpo = decode_entities(title);
            let mut novo = item.clone();
            if limpo != title {
                if item.title.is_some() {
                    novo.title = Some(limpo.clone());
                }
                if item.title_pascal.is_some() {
                    novo.title_pascal = Some(limpo);
                }
            }
            novo
        })
        .collect();

    // ptTitleDual IN-PROCESS: o contexto pt/original/en veio do `SearchMeta`;
    // a decisão é do núcleo, não da flag que a rota anexou ao item. Marca antes
    // do filtro de título — o lote filtrado também alimenta o índice de releases.
    apply_pt_title_dual(&mut raw, ctx.titles.as_ref());

    // 2. Release falsa: executável no título/dn, mesmo hash de um executável
    //    e irmão com a base de um executável do lote/acervo (bases injetadas).
    let before = raw.len();
    raw = drop_fake_releases(raw, ctx);
    if before != raw.len() {
        out.count("fake-release", before - raw.len());
    }

    // 3. Filtro de título (o gate é a existência de ALGUM nome, não do meta).
    out.entered_raw = raw.clone();
    if !ctx.names.is_empty() && !ctx.is_demo {
        let before = raw.len();
        let from_account: Vec<RawItem> = raw.iter().filter(|r| r.from_account).cloned().collect();
        let restantes: Vec<RawItem> = raw.iter().filter(|r| !r.from_account).cloned().collect();
        let relevância: Vec<adom_core::RelevanceItem> =
            restantes.iter().map(RawItem::to_relevance).collect();
        let outcome = filter_relevant_raw(
            &relevância,
            &relevance_query(ctx),
            &relevance_settings(ctx, opts),
        );
        raw = from_account
            .into_iter()
            .chain(outcome.kept.iter().map(|&i| restantes[i].clone()))
            .collect();
        if before != raw.len() {
            out.count("title-filter", before - raw.len());
        }
    }

    // 4. Pack multiobra: marca ANTES das guardas (o admitido é exceção às
    //    retenções), depois guarda de coleção sem escolha por arquivo.
    //    O lote que chega aqui já passou pelo filtro de título: é o que o
    //    índice de releases grava (`filtered_raw`).
    out.filtered_raw = raw.clone();
    if let Some(root) = ctx.multi_work_root.as_deref() {
        for item in &mut raw {
            if item.multi_work_admitted {
                continue;
            }
            item.multi_work_admitted = admits_multi_work_pack(
                item.title_text(),
                item.magnet.as_deref().unwrap_or(""),
                Some(root),
                &ctx.year,
                ctx.season.is_some(),
                &ctx.names,
            );
        }
    }
    if ctx.season.is_none() && !ctx.is_demo && (!ctx.debrid_available || first_year(&ctx.year) == 0)
    {
        let before = raw.len();
        raw.retain(|r| !is_multi_work_collection(r.title_text()));
        if before != raw.len() {
            out.count("multiwork-retained", before - raw.len());
        }
    }

    // Dica de obra para o pickFile no play (só filme): nomes + ano limpo.
    let work_hint = work_hint_of(ctx);
    // H2: com opt-in multiobra, coleção sem dica de obra não vai à lista.
    if ctx.multi_work_root.is_some() && ctx.season.is_none() && !ctx.is_demo && work_hint.is_none()
    {
        let before = raw.len();
        raw.retain(|r| !r.multi_work_admitted && !is_multi_work_collection(r.title_text()));
        if before != raw.len() {
            out.count("multiwork-retained", before - raw.len());
        }
    }

    // 5. Episódio: packs passam (o debrid escolhe o arquivo no play).
    if let (Some(season), Some(episode)) = (ctx.season, ctx.episode) {
        if !ctx.is_demo {
            let before = raw.len();
            let unaired = opts.unaired_margin_ms > 0
                && ctx
                    .episode_aired_at_ms
                    .is_some_and(|air| air - ctx.now_ms > opts.unaired_margin_ms);
            let pre_air = pre_air_hashes(&raw, ctx, opts);
            let universe: Vec<String> = ctx
                .names
                .iter()
                .flat_map(|n| {
                    normalize_title(n)
                        .split(' ')
                        .filter(|t| !t.is_empty())
                        .map(String::from)
                        .collect::<Vec<_>>()
                })
                .collect();
            let items: Vec<adom_core::EpisodeFilterItem> =
                raw.iter().map(RawItem::to_episode_filter).collect();
            let outcome = filter_series_episode(
                &items,
                season,
                episode,
                &universe,
                &ctx.names,
                unaired,
                &pre_air,
                opts.title_precision_tail_cut,
            );
            raw = outcome
                .kept
                .iter()
                .map(|&i| raw[i as usize].clone())
                .collect();
            if before != raw.len() {
                out.count("episode-mismatch", before - raw.len());
            }
        }
    }

    // 6. Mapeia para o stream de ranking (coluna estreita via `stream_display_name`
    //    do núcleo) e ordena no POOL AMPLIADO.
    let mut mapped: Vec<RankingStream> = raw
        .iter()
        .filter_map(|item| map_stream(item, display, &opts.audio_audit))
        .collect();
    // 6b. `pruneKnownBroken` (F4.4a): o histórico `bad`/`lie` desta conta sai
    //     AQUI, antes da checagem do debrid — a mesma marca `broken` que a rota
    //     de evidência do Node põe no item, só que vinda do `cache.db` lido
    //     pela fonte injetada. Sem fonte o conjunto é vazio e o funil segue
    //     idêntico ao do corpus.
    if !ctx.broken_hashes.is_empty() {
        for stream in &mut mapped {
            let known_broken = stream
                .info_hash
                .as_deref()
                .map(str::to_ascii_lowercase)
                .is_some_and(|hash| ctx.broken_hashes.contains(&hash));
            if known_broken {
                stream.extra.insert("_broken".into(), true.into());
            }
        }
    }
    let sem_hash = raw.len() - mapped.len();
    if sem_hash > 0 {
        out.count("no-hash", sem_hash);
    }
    let pool_size = opts.max_results * opts.candidate_pool_factor;
    let sort = sort_and_limit(&SortInput {
        streams: mapped,
        options: SortOptions {
            min_seeders: seed_floor_for(opts, ctx),
            max_results: pool_size,
            quality_filter: opts.qualities.clone(),
            season: ctx.season,
            episode: ctx.episode,
            prefer_dubbed: opts.prefer_dubbed,
            dubbed_only: opts.dubbed_only,
            exclude_cam: opts.exclude_cam,
            max_size_gb: opts.max_size_gb,
            quality_limits: opts.quality_limits.clone(),
            br_reserved_slots: opts.br_reserved_slots,
            br_reserved_per_quality: opts.br_reserved_per_quality,
            candidate_factor: opts.candidate_pool_factor,
            br_first: opts.br_first,
            indexer_priority: opts.indexer_priority.clone(),
        },
        instant_hashes: opts.instant_hashes.iter().cloned().collect(),
    });
    out.count("afterSort", sort.streams.len());
    let mut streams = sort.streams;

    // 7. 💾 de episódio (pack: média; multiobra: só medida exata). Antes do
    //    debrid — o título reescrito sobrevive à materialização.
    //
    //    Com o estado do memo na passada de BUILD (`files_at_build`, gravado
    //    pelo record), roda o MESMO composto do Node da 1ª chamada de
    //    `annotateEpisodeSizes`: total do torrent → anotação → corte do texto →
    //    fill do 💾. É o que decide se o `📦 pack` da 2ª passada nasce — o Node
    //    só o emite quando a 1ª passada já preencheu o 💾 (Breaking Bad alterna
    //    entre `💾 X` e `💾 X 📦 pack X` conforme o `fsz` estava quente).
    let files_build = ctx.files_at_build.as_ref().unwrap_or(&ctx.files_by_hash);
    if let (Some(season), Some(episode)) = (ctx.season, ctx.episode) {
        let pack_opts = PackOpts {
            season,
            episode,
            meta: &ctx.episode_counts,
        };
        let duas_passadas = ctx.files_at_build.is_some();
        if duas_passadas {
            let totals = ctx.totals_at_build.clone().unwrap_or_default();
            streams = adom_core::fill_torrent_totals_core(&streams, files_build, &totals);
        }
        streams = annotate_pack_sizes_core(&streams, files_build, &pack_opts);
        // 7b. Pack que a anotação NÃO reduziu (sem medida exata nem média) perde
        // o total do TEXTO: exibir a temporada inteira como tamanho do episódio
        // é o defeito reportado. Mesmo passo do `dropPackTextTotals` do TS,
        // que roda DEPOIS do `annotatePackSizes`: pack anotado (`📦`) e release
        // que nomeia o episódio pedido ficam; pack de título silencioso
        // ("Naruto Complete (001-220 + Movies)") não é reconhecido pelo
        // `isSeasonPackRelease` e é justamente o caso que o corte cobre.
        // A lista de arquivos (memo `fsz`) é a mesma do build inteiro: sem ela
        // o pack de título silencioso não teria como provar o total.
        streams = adom_core::drop_pack_text_totals(&adom_core::PackTextTotalsInput {
            streams,
            season: Some(season),
            episode: Some(episode),
            files: files_build.clone().into_iter().collect(),
        })
        .streams;
        if duas_passadas {
            let work = work_hint.as_ref().map(|hint| adom_core::WorkHint {
                names: hint.names.clone(),
                year: hint.year,
                pack: true,
            });
            streams = adom_core::fill_missing_sizes_core(
                &streams,
                files_build,
                &adom_core::FillOpts {
                    season: Some(season),
                    episode: Some(episode),
                    work: work.as_ref(),
                },
            );
        }
    }
    if let Some(hint) = &work_hint {
        let debrid_hint = DebridWorkHint {
            names: hint.names.clone(),
            year: hint.year,
            pack: false,
        };
        streams = annotate_movie_sizes_core(&streams, &ctx.files_by_hash, &debrid_hint);
    }

    // Contagem ANTES do debrid: o aviso "nada em cache" é medido antes do corte.
    out.candidates_before_debrid = streams.len();
    out.br_entered_debrid = streams.iter().filter(|s| s.br.unwrap_or(false)).count();
    out.dub_entered_debrid = streams
        .iter()
        .filter(|s| {
            s.br.unwrap_or(false) && (s.dubbed.unwrap_or(false) || s.dub_claim.unwrap_or(false))
        })
        .count();

    // 8. applyDebrid — um lote (prepare) + memo por stream. Sem prepare o
    //    AdapterDebridCheck cai no lazy da 1ª check (ainda 1 upload AD).
    // `fallbackInList` do TS é lido da lista FINAL, depois do drop do
    // `playDisposition` e do corte: guarda os hashes das reservas para marcar a
    // entrada depois do `finalize` (o `BuiltStream` não carrega a marca `_*`).
    let fallback_hashes: BTreeSet<String> = streams
        .iter()
        .filter(|s| {
            ["_fromFallback", "_fromSnapshot"]
                .iter()
                .any(|key| s.extra.get(*key).and_then(|v| v.as_bool()).unwrap_or(false))
        })
        .filter_map(|s| s.info_hash.clone().filter(|hash| !hash.is_empty()))
        .collect();
    let built = finalize_streams(streams, ctx, opts, debrid, &mut out);
    out.fallback = built
        .iter()
        .filter(|stream| !stream.notice)
        .filter_map(|stream| stream.info_hash.as_deref())
        .any(|hash| fallback_hashes.contains(hash));
    out.streams = built;
    out.work_hint = work_hint;
    out
}
