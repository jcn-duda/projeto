use std::collections::{HashMap, HashSet};

use serde_json::Value;

use adom_core::{
    limit_reserving_br_trace, play_disposition, uncached_br_hashes, LimitBrOpts, PlayDisposition,
    PlayFacts, PoolStream, RankingStream, StreamRef,
};

use super::helpers::{notice_text, ranking_to_pool, stream_to_ref, to_stream_item, work_hint_of};
use super::types::{BuildContext, BuildOptions, BuiltList, BuiltStream, DebridAnswer, DebridCheck};

pub fn finalize_streams(
    streams: Vec<RankingStream>,
    ctx: &BuildContext,
    opts: &BuildOptions,
    debrid: &mut dyn DebridCheck,
    out: &mut BuiltList,
) -> Vec<BuiltStream> {
    // 7b. `pruneKnownBroken`: o que a conta já provou quebrado sai ANTES da
    //     checagem — não se gasta lote com fracasso conhecido (e o corte final
    //     não reserva vaga para ele).
    let streams: Vec<RankingStream> = streams
        .into_iter()
        .filter(|s| !s.extra.contains_key("_broken"))
        .collect();
    out.count("afterBroken", streams.len());
    // Universo do Chupim: a lista pós-checagem INTEIRA, porque o `applyDebrid`
    // chama `autoFetchCandidates` ANTES do corte `cachedOnly` (o BR frio é
    // justamente o alvo do download). `kept` já saiu cortado e não serve.
    // Guardado como item COMPACTO (não clona o stream inteiro): os fatos da
    // versão anotada de `kept` são refrescados no fim.
    let mut autofetch_batch = super::effects::autofetch_items(&streams);

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
    // Qualquer hash sem veredito derruba o `known` do LOTE (Node: resposta
    // parcial/degradada manda tudo pelo `/resolve`).
    let mut unknown_seen = false;
    // `unusable` (auth/quota) é do LOTE: o Node devolve a lista como P2P e
    // descarta os packs multiobra num único `return`, antes de qualquer
    // materialização.
    let mut unusable_seen = false;
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
                unknown_seen = true;
                kept.push(stream);
            }
            DebridAnswer::Unusable => {
                // auth/quota não é resposta sobre o cache: o Node devolve
                // `known:false` (P2P, TTL curto, sem autofetch).
                out.debrid_unusable = true;
                unusable_seen = true;
                kept.push(stream);
            }
            DebridAnswer::P2p => {
                // Hash isolado sem link do debrid: fica P2P, mas os `[AD⚡]`
                // do mesmo lote continuam materizados.
                out.debrid_known = true;
                stream.extra.insert("_p2p".into(), true.into());
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
    // 8b. `playDisposition` — a MESMA decisão do Node (`adom_core`): multiobra
    //     admitida fora do cache sem `resolveUncached` sai ANTES do corte final,
    //     senão ocuparia vaga de quem tocaria. A URL em si nasce no `finish`
    //     (prefixo/segredo são da requisição); aqui fica só a marca.
    // O knob só age com debrid ATIVO e veredito utilizável: sem serviço/chave
    // ninguém perguntou (`NoDebridCheck` responde `Unknown`) e `Unusable`
    // (auth/quota) é conta que não responde — nos dois casos o Node devolve
    // P2P e descarta multiobra, em vez de gerar `/resolve` para morrer no play.
    let check_usable = ctx.debrid_available && !ctx.debrid_check_disabled && !unusable_seen;
    let degraded = check_usable && unknown_seen;
    let resolve_uncached = check_usable && ctx.debrid_resolve_uncached;
    kept.retain(|stream| {
        let p2p = stream
            .extra
            .get("_p2p")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        disposition_of(stream, degraded, resolve_uncached, unusable_seen || p2p)
            != PlayDisposition::Drop
    });
    out.count("afterDebrid", kept.len());

    // 8c. `fillMissingSizes` do Node (`debrid-pipeline-core.ts`): DEPOIS da
    //     checagem, quem veio sem `💾` recebe o tamanho do arquivo que o play
    //     tocaria (`fsz`). O Node roda esta anotação de novo no fim do
    //     applyDebrid (a de antes do debrid não vê a lista que a própria
    //     checagem aqueceu); sem este passo o item que o tracker publicou sem
    //     tamanho — TorrentDosFilmes/apachetorrent — fica sem `💾` e a resposta
    //     diverge do Node. Só medida exata: hash sem lista segue sem `💾`.
    //
    //     Conta `unusable` (auth/quota): o Node sai do `applyDebrid` ANTES desta
    //     anotação (o P2P volta como está, só com o que a 1ª passada mediu).
    //     Com o estado da 1ª passada no record (`files_at_build`), repetir o
    //     composto aqui acrescentava `📦 pack` que o Node não emite (Breaking
    //     Bad: `💾 481.87 MB` × `💾 481.87 MB 📦 pack 481.87 MB`). Captura
    //     antiga (sem o mapa do build) mantém a régua anterior.
    let duas_passadas = ctx.files_at_build.is_some();
    let pos_checagem = !(duas_passadas && unusable_seen);
    let files_ref = if pos_checagem {
        &ctx.files_by_hash
    } else {
        ctx.files_at_build.as_ref().unwrap_or(&ctx.files_by_hash)
    };
    let totals_ref = if pos_checagem {
        &ctx.totals_by_hash
    } else {
        ctx.totals_at_build.as_ref().unwrap_or(&ctx.totals_by_hash)
    };
    let hint = work_hint_of(ctx);
    let work = hint.as_ref().map(|hint| adom_core::WorkHint {
        names: hint.names.clone(),
        year: hint.year,
        pack: true,
    });
    // 8c.1 `fillTorrentTotals` (`tsz`, passo 1 do `annotateEpisodeSizes`).
    kept = adom_core::fill_torrent_totals_core(&kept, files_ref, totals_ref);
    // 8d. Reanotação de PACK (2ª passada do Node), NA ORDEM dele: anotar →
    //     cortar o total do texto → preencher 💾 (abaixo). O `_size` não chega
    //     nesta chamada no Node (o `sortAndLimit` o apaga): anotar com o size
    //     bruto faria o guard `exato >= total` pular justamente os packs que o
    //     Node anota. O 💾 que já existe veio da 1ª passada e vira o total.
    if pos_checagem {
        if let (Some(season), Some(episode)) = (ctx.season, ctx.episode) {
            let pack_opts = adom_core::PackOpts {
                season,
                episode,
                meta: &ctx.episode_counts,
            };
            let mut sem_size = kept.clone();
            for stream in &mut sem_size {
                stream.size = None;
            }
            let anotado = adom_core::drop_pack_text_totals(&adom_core::PackTextTotalsInput {
                streams: adom_core::annotate_pack_sizes_core(&sem_size, files_ref, &pack_opts),
                season: Some(season),
                episode: Some(episode),
                files: files_ref.clone().into_iter().collect(),
            })
            .streams;
            // Só título/marcador mudam; o size original de cada item é
            // preservado para os passos seguintes (filtros já rodaram com ele).
            kept = anotado
                .into_iter()
                .zip(kept)
                .map(|(mut anotado, original)| {
                    anotado.size = original.size;
                    anotado
                })
                .collect();
        }
    }
    kept = adom_core::fill_missing_sizes_core(
        &kept,
        // O fill do Node usa o `fsz` já aquecido pela checagem, inclusive
        // quando ela termina `unusable`: o item P2P que sobrou ainda ganha o
        // 💾 exato (Game of Thrones S08E03, 1.76 GB). O `files_at_build` só
        // governa a anotação de pack (que não pode nascer nesse caso).
        &ctx.files_by_hash,
        &adom_core::FillOpts {
            season: ctx.season,
            episode: ctx.episode,
            work: work.as_ref(),
        },
    );

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

    // Efeitos de cauda: o `applyDebrid` do Node os decide ANTES do
    // `limitReservingBr` (sobre o pool pós-debrid, não sobre o corte final) —
    // por isso a seleção roda aqui, com `kept` e o conjunto de hashes cacheados
    // da checagem. Emitir é do orquestrador (`EFFECTS_RUST`).
    out.effect_seeds = super::effects::collect(&kept, &cached_hashes, ctx.season, ctx.episode);
    // O lote do Chupim usa o universo pré-corte, mas com os fatos da versão
    // ANOTADA de quem sobreviveu (o Node anota antes de escolher os
    // candidatos). Só os campos que a anotação pode mexer são refrescados.
    let annotated: HashMap<String, &RankingStream> = kept
        .iter()
        .filter_map(|stream| {
            stream
                .info_hash
                .as_deref()
                .map(|hash| (hash.to_lowercase(), stream))
        })
        .collect();
    for item in &mut autofetch_batch {
        if let Some(stream) = annotated.get(&item.hash.to_lowercase()) {
            if let Some(refreshed) = super::effects::autofetch_item_of(stream) {
                *item = refreshed;
            }
        }
    }
    out.effect_seeds.autofetch = autofetch_batch;

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
            multi_work: s.multi_work.unwrap_or(false),
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
                multi_work: false,
            });
        }
    }
    built
}

/// Fatos do stream para o núcleo. `degraded` é do LOTE (`known:false`), não do
/// item: o Node manda a lista inteira pelo `/resolve` quando a checagem não
/// fechou, e o multiobra admitido continua sendo exceção (drop sem o knob).
/// `resolve_uncached` já chega depurado por disponibilidade/`Unusable` — o
/// núcleo continua sendo a única régua de P2P × `/resolve` × drop. Em
/// `Unusable` o ⚡ também é descartado: o Node devolve a lista inteira como
/// P2P (a conta não responde, nem para o que o memo/`davail` confirmou).
fn disposition_of(
    stream: &RankingStream,
    degraded: bool,
    resolve_uncached: bool,
    unusable: bool,
) -> PlayDisposition {
    play_disposition(&PlayFacts {
        has_info_hash: stream
            .info_hash
            .as_deref()
            .is_some_and(|hash| !hash.is_empty()),
        multi_work_admitted: stream.multi_work_admitted.unwrap_or(false),
        cached: !unusable
            && stream
                .extra
                .get("cached")
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
        resolve_uncached,
        degraded,
    })
}
