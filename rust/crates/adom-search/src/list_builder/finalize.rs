use std::collections::HashSet;

use adom_core::{
    limit_reserving_br_trace, uncached_br_hashes, LimitBrOpts, PoolStream, RankingStream, StreamRef,
};

use super::helpers::{notice_text, ranking_to_pool, stream_to_ref, to_stream_item};
use super::types::{BuildContext, BuildOptions, BuiltList, BuiltStream, DebridAnswer, DebridCheck};

pub fn finalize_streams(
    streams: Vec<RankingStream>,
    ctx: &BuildContext,
    opts: &BuildOptions,
    debrid: &mut dyn DebridCheck,
    out: &mut BuiltList,
) -> Vec<BuiltStream> {
    // 8. applyDebrid (na ordem do TS: prepare() em lote se o serviço aceita,
    //    depois check() por stream).
    let batch: Vec<String> = streams
        .iter()
        .filter_map(|s| s.info_hash.clone())
        .filter(|h| !h.is_empty())
        .collect();
    debrid.prepare(&batch);

    let mut kept: Vec<RankingStream> = Vec::with_capacity(streams.len());
    let mut missing: Vec<RankingStream> = Vec::new();
    let mut cached_hashes: HashSet<String> = HashSet::new();
    for mut stream in streams {
        match debrid.check(&stream) {
            DebridAnswer::Cached { url } => {
                out.debrid_known = true;
                if let Some(url) = url {
                    stream.extra.insert("url".into(), url.into());
                }
                stream.extra.insert("cached".into(), true.into());
                if let Some(h) = stream.info_hash.as_deref().filter(|h| !h.is_empty()) {
                    cached_hashes.insert(h.to_string());
                }
                kept.push(stream);
            }
            DebridAnswer::Missing => {
                out.debrid_known = true;
                // cachedOnly: frio vai a `missing` e a exceção BR decide abaixo;
                // sem cachedOnly tudo passa como P2P.
                if ctx.debrid_cached_only {
                    missing.push(stream);
                } else {
                    kept.push(stream);
                }
            }
            DebridAnswer::Unknown => {
                // known:false NÃO é "nada em cache": passa sem ⚡ e o passe
                // tardio refaz.
                out.needs_debrid_refresh = true;
                kept.push(stream);
            }
            DebridAnswer::Unusable => {
                out.debrid_known = true;
                out.debrid_unusable = true;
                kept.push(stream);
            }
        }
    }
    if ctx.debrid_cached_only && !missing.is_empty() {
        let visible = if ctx.show_uncached_br {
            // Universo = ⚡ já mantidos + frios: a conta de BR em cache reduz
            // as vagas P2P (br_reserved_slots − cached_br), como no TS.
            let pool: Vec<PoolStream> = kept
                .iter()
                .chain(missing.iter())
                .map(ranking_to_pool)
                .collect();
            let slots = (opts.br_reserved_slots as i64)
                .saturating_sub(
                    pool.iter()
                        .filter(|s| {
                            s.is_br
                                && (s.is_dubbed || s.is_dub_claim || s.is_bank_dub)
                                && s.info_hash.as_deref().is_some_and(|h| {
                                    cached_hashes.iter().any(|c| c.eq_ignore_ascii_case(h))
                                })
                        })
                        .count() as i64,
                )
                .max(0);
            uncached_br_hashes(&pool, &cached_hashes, slots)
        } else {
            Vec::new()
        };
        for stream in missing {
            let original = stream.info_hash.clone().unwrap_or_default();
            if visible.iter().any(|h| h == &original) {
                kept.push(stream);
            }
        }
    }
    out.count("afterDebrid", kept.len());

    // 9. limitReservingBr — o corte final é DEPOIS do pool ampliado; inverter
    //    faz o BR (sem seeders publicados) sumir (invariante 3).
    let refs: Vec<StreamRef> = kept.iter().map(|s| stream_to_ref(s, ctx.season)).collect();
    let limit = limit_reserving_br_trace(
        &refs,
        &LimitBrOpts {
            br_reserved_slots: opts.br_reserved_slots,
            br_reserved_per_quality: opts.br_reserved_per_quality,
            max_results: opts.max_results,
            br_only: opts.br_only,
            quality_limits: opts.quality_limits.clone(),
            br_first: opts.br_first,
            max_per_indexer: opts.max_per_indexer,
            indexer_limits: opts.indexer_limits.clone(),
            season: ctx.season,
        },
    );
    let finais: Vec<RankingStream> = limit.selected.iter().map(|&i| kept[i].clone()).collect();
    out.count("final", finais.len());

    // 10. Aviso se vazia — o TEXTO nasce relativo (o link é do origin).
    let mut built: Vec<BuiltStream> = finais
        .iter()
        .map(|s| BuiltStream {
            item: to_stream_item(s),
            is_br: s.br.unwrap_or(false),
            notice: false,
            cached: s
                .extra
                .get("cached")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            info_hash: s.info_hash.clone(),
            // Prova ou promessa: as duas entram na dica `d` do `/resolve`.
            dubbed: s.dubbed.unwrap_or(false) || s.dub_claim.unwrap_or(false),
            multi_work_admitted: s.multi_work_admitted.unwrap_or(false),
        })
        .collect();
    if opts.notice_stream && built.is_empty() {
        if let Some(name) = notice_text(ctx, out) {
            out.count("notice", 1);
            built.push(BuiltStream {
                item: crate::contract::StreamItem {
                    name: Some(name),
                    ..Default::default()
                },
                is_br: false,
                notice: true,
                cached: false,
                info_hash: None,
                dubbed: false,
                multi_work_admitted: false,
            });
        }
    }
    built
}
