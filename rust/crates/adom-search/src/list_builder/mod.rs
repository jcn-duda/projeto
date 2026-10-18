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

#[cfg(test)]
mod tests;
mod types;

pub use types::{
    apply_notice_origin, seed_floor_for, BuildContext, BuildOptions, BuiltList, BuiltStream,
    DebridAnswer, DebridCheck, WorkHint,
};

use std::collections::BTreeMap;

use adom_core::{
    admits_multi_work_pack, annotate_movie_sizes_core, annotate_pack_sizes_core, audio_from_title,
    bytes_to_size, decode_entities, edition_from_title, filter_relevant_raw, filter_series_episode,
    is_multi_work_collection, is_season_pack_release, limit_reserving_br_trace, looks_pt_br,
    normalize_title, quality_from_title, sort_and_limit, source_from_title, stream_display_name,
    stream_size_label, DebridFile, JsText, LimitBrOpts, PackOpts, RankingStream, RelevanceQuery,
    RelevanceSettings, SortInput, SortOptions, StreamDisplayConfig, StreamDisplayOptions,
    StreamRef, WorkHint as DebridWorkHint,
};

use crate::raw_item::RawItem;

/// Extensões executáveis do corte de release falsa (corte 1 de
/// `fake-release.ts`; o corte 2 do irmão depende do acervo — bases injetadas).
const EXECUTABLE_EXTS: [&str; 8] = [
    ".exe", ".scr", ".lnk", ".bat", ".cmd", ".msi", ".pif", ".vbs",
];

/// O título ou o `dn=` declara um executável? A extensão fecha o nome ou vem
/// antes de espaço/colchete/parêntese/pontuação — `DVDSCR` e `site.com` não
/// casam.
fn is_executable_release(title: &str, dn: &str) -> bool {
    fn has_ext(text: &str) -> bool {
        let lower = text.to_lowercase();
        for ext in EXECUTABLE_EXTS {
            let mut from = 0;
            while let Some(pos) = lower[from..].find(ext) {
                let end = from + pos + ext.len();
                let next = lower[end..].chars().next();
                if next.is_none() || next.is_some_and(|c| " \t)]|,;".contains(c)) {
                    return true;
                }
                from = from + pos + 1;
            }
        }
        false
    }
    has_ext(title) || has_ext(dn)
}

/// Nome comparável do irmão: sem a extensão, sem pontuação, minúsculas.
fn fake_release_base(title: &str) -> String {
    let mut lowered = title.to_lowercase();
    for ext in EXECUTABLE_EXTS {
        lowered = lowered.replace(ext, " ");
    }
    lowered
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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

    // 2. Release falsa: executável no título/dn, mesmo hash de um executável
    //    e irmão com a base de um executável do lote/acervo (bases injetadas).
    let before = raw.len();
    raw = drop_fake_releases(raw, ctx);
    if before != raw.len() {
        out.count("fake-release", before - raw.len());
    }

    // 3. Filtro de título (o gate é a existência de ALGUM nome, não do meta).
    if !ctx.names.is_empty() && !ctx.is_demo {
        let before = raw.len();
        let from_account: Vec<RawItem> = raw.iter().filter(|r| r.from_account).cloned().collect();
        let restantes: Vec<RawItem> = raw.iter().filter(|r| !r.from_account).cloned().collect();
        let query = RelevanceQuery {
            names: &ctx.names,
            year: &ctx.year,
            alt_year: ctx.alt_year.as_deref(),
            is_series: ctx.season.is_some(),
            season: None,
            episode: None,
            multi_work_root: ctx.multi_work_root.as_deref(),
            home_release_at: None,
        };
        let settings = RelevanceSettings {
            now_ms: ctx.now_ms,
            pre_home_release_cut: opts.pre_home_release_cut,
            pre_home_release_margin_ms: opts.pre_home_release_margin_ms,
            title_precision_tail_cut: opts.title_precision_tail_cut,
        };
        let relevância: Vec<adom_core::RelevanceItem> =
            restantes.iter().map(RawItem::to_relevance).collect();
        let outcome = filter_relevant_raw(&relevância, &query, &settings);
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
    let mapped: Vec<RankingStream> = raw
        .iter()
        .filter_map(|item| map_stream(item, display))
        .collect();
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
        instant_hashes: Default::default(),
    });
    out.count("afterSort", sort.streams.len());
    let mut streams = sort.streams;

    // 7. 💾 de episódio (pack: média; multiobra: só medida exata). Antes do
    //    debrid — o título reescrito sobrevive à materialização.
    if let (Some(season), Some(episode)) = (ctx.season, ctx.episode) {
        let files: BTreeMap<String, Vec<DebridFile>> = BTreeMap::new();
        let pack_opts = PackOpts {
            season,
            episode,
            meta: &ctx.episode_counts,
        };
        streams = annotate_pack_sizes_core(&streams, &files, &pack_opts);
    }
    if let Some(hint) = &work_hint {
        let files: BTreeMap<String, Vec<DebridFile>> = BTreeMap::new();
        let debrid_hint = DebridWorkHint {
            names: hint.names.clone(),
            year: hint.year,
            pack: false,
        };
        streams = annotate_movie_sizes_core(&streams, &files, &debrid_hint);
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
    let batch: Vec<String> = streams
        .iter()
        .filter_map(|s| s.info_hash.clone())
        .filter(|h| !h.is_empty())
        .collect();
    debrid.prepare(&batch);
    let mut kept = Vec::with_capacity(streams.len());
    for mut stream in streams {
        match debrid.check(&stream) {
            DebridAnswer::Cached { url } => {
                out.debrid_known = true;
                if let Some(url) = url {
                    stream.extra.insert("url".into(), url.into());
                }
                stream.extra.insert("cached".into(), true.into());
                kept.push(stream);
            }
            DebridAnswer::Missing => {
                out.debrid_known = true;
                // cachedOnly corta o frio; o resto passa como P2P.
                if !ctx.debrid_cached_only {
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
        })
        .collect();
    if opts.notice_stream && built.is_empty() {
        if let Some(name) = notice_text(ctx, &out) {
            out.count("notice", 1);
            built.push(BuiltStream {
                item: crate::contract::StreamItem {
                    name: Some(name),
                    ..Default::default()
                },
                is_br: false,
                notice: true,
                cached: false,
            });
        }
    }
    out.streams = built;
    out.work_hint = work_hint;
    out
}

// ── Passos ──────────────────────────────────────────────────────────────────

fn drop_fake_releases(raw: Vec<RawItem>, ctx: &BuildContext) -> Vec<RawItem> {
    let mut executables: Vec<usize> = Vec::new();
    let mut bases: Vec<String> = ctx.executable_bases.clone();
    for (i, item) in raw.iter().enumerate() {
        if is_executable_release(item.title_text(), &item.dn()) {
            executables.push(i);
            if !item.from_account {
                bases.push(fake_release_base(item.title_text()));
            }
        }
    }
    // O MESMO hash de um executável provado é o mesmo torrent, venha de onde vier.
    let exe_hashes: Vec<String> = executables
        .iter()
        .map(|&i| raw[i].hash())
        .filter(|h| !h.is_empty())
        .collect();
    for (i, item) in raw.iter().enumerate() {
        let h = item.hash();
        if !h.is_empty() && exe_hashes.contains(&h) && !executables.contains(&i) {
            executables.push(i);
        }
    }
    let exe_set = &executables;
    let twins: Vec<usize> = raw
        .iter()
        .enumerate()
        .filter(|(i, item)| {
            !exe_set.contains(i)
                && !item.from_account
                && bases
                    .iter()
                    .any(|b| *b == fake_release_base(item.title_text()))
        })
        .map(|(i, _)| i)
        .collect();
    if executables.is_empty() && twins.is_empty() {
        return raw;
    }
    let cortados: Vec<usize> = executables.into_iter().chain(twins).collect();
    raw.into_iter()
        .enumerate()
        .filter(|(i, _)| !cortados.contains(i))
        .map(|(_, item)| item)
        .collect()
}

fn first_year(year: &str) -> i64 {
    year.chars()
        .collect::<Vec<_>>()
        .windows(4)
        .find_map(|w| w.iter().collect::<String>().parse::<i64>().ok())
        .unwrap_or(0)
}

fn work_hint_of(ctx: &BuildContext) -> Option<WorkHint> {
    if ctx.season.is_some() || ctx.names.is_empty() {
        return None;
    }
    let names = ctx.names.iter().take(4).cloned().collect();
    let year = first_year(&ctx.year);
    Some(WorkHint {
        names,
        year: if year == 0 { None } else { Some(year) },
    })
}

/// Hashes que já existiam bem antes da estreia (margem de 48h): torrent é
/// imutável, então o pack velho não o contém e quem o nomeia é falso. BR fica
/// de fora (o post é datado pela página da temporada) e na conta só vale o
/// `first_seen` (injetado).
fn pre_air_hashes(raw: &[RawItem], ctx: &BuildContext, opts: &BuildOptions) -> Vec<String> {
    let mut out = Vec::new();
    let Some(air_at) = ctx.episode_aired_at_ms else {
        return out;
    };
    if opts.pre_air_margin_ms <= 0 {
        return out;
    }
    let limit = air_at - opts.pre_air_margin_ms;
    for item in raw {
        if item.is_br {
            continue;
        }
        let hash = item.hash();
        if hash.is_empty() {
            continue;
        }
        let mut dates: Vec<f64> = Vec::new();
        if !item.from_account {
            if let Some(p) = item.published_at {
                dates.push(p);
            }
        }
        if let Some(seen) = ctx.first_seen_ms.get(&hash) {
            dates.push(*seen);
        }
        let sane = dates.into_iter().filter(|d| *d > 946_684_800_000.0);
        if let Some(min) = sane.fold(None::<f64>, |acc, d| Some(acc.map_or(d, |a: f64| a.min(d)))) {
            if min < limit as f64 {
                out.push(hash);
            }
        }
    }
    out
}

/// Mapeia o item cru para o stream de ranking: hash (sem hash morre — link que
/// nenhum resolvedor abriu), origem BR (campo + `looks_pt_br`), áudio/qualidade
/// e a coluna estreita via `stream_display_name` do NÚCLEO (`JsText` preserva
/// surrogate órfão dentro do build; a conversão para o `String` do contrato só
/// acontece na borda — ver [`js_to_contract_string`]).
fn map_stream(item: &RawItem, display: &StreamDisplayConfig) -> Option<RankingStream> {
    let hash = item.hash();
    if hash.is_empty() {
        return None;
    }
    let title = item.title_text().to_string();
    let br = item.is_br || looks_pt_br(&title);
    let audio = audio_from_title(&title);
    let quality = quality_from_title(&title).to_string();
    let stats = stats_line(item);
    let full_title = if stats.is_empty() {
        title.clone()
    } else {
        format!("{title}\n{stats}")
    };
    let name_text = stream_display_name(
        &StreamDisplayOptions {
            title: Some(&title),
            quality: Some(&quality),
            audio: Some(audio),
            source: Some(source_from_title(&title)),
            edition: Some(edition_from_title(&title)),
            tracker: item.indexer.as_deref(),
            is_br: br,
            seeders: Some(&types::seeders_value_of(item.seeders)),
            from_fallback: item.from_fallback,
            style: None,
            show_source: None,
        },
        None,
        display,
    );
    let mut stream = RankingStream {
        info_hash: Some(hash),
        title: Some(full_title),
        name: Some(js_to_contract_string(&name_text)),
        quality: Some(quality),
        seeders: item.seeders,
        size: item.size_bytes,
        bytes: item.size_bytes,
        br: Some(br),
        // Prova primeiro; Dual é promessa (o núcleo decide no ranking).
        dubbed: Some(br && audio == "Dublado"),
        dub_claim: Some(br && audio == "Dual"),
        indexer: item.indexer.clone(),
        lied: item.lied.then_some(true),
        multi_work_admitted: item.multi_work_admitted.then_some(true),
        ..RankingStream::default()
    };
    if !item.sources.is_empty() {
        stream
            .extra
            .insert("sources".into(), item.sources.clone().into());
    }
    Some(stream)
}

/// Linha de estatísticas do título (`👤 N 💾 X`), como o `toStremioStream`.
fn stats_line(item: &RawItem) -> String {
    let mut parts: Vec<String> = Vec::new();
    if item.seeders.unwrap_or(0.0) > 0.0 {
        let n = item.seeders.unwrap_or(0.0);
        parts.push(format!(
            "👤 {}",
            if n.fract() == 0.0 {
                format!("{}", n as i64)
            } else {
                format!("{n}")
            }
        ));
    }
    if let Some(bytes) = item.size_bytes.filter(|b| *b > 0.0) {
        if let Some(label) = bytes_to_size(bytes) {
            parts.push(format!("💾 {label}"));
        }
    }
    parts.join(" ")
}

fn stream_to_ref(stream: &RankingStream, season: Option<i64>) -> StreamRef {
    StreamRef {
        title: stream.title.clone().unwrap_or_default(),
        quality: stream.quality.clone(),
        indexer: stream.indexer.clone(),
        is_br: stream.br.unwrap_or(false),
        is_dubbed: stream.dubbed.unwrap_or(false),
        is_dub_claim: stream.dub_claim.unwrap_or(false),
        is_lied: stream.lied.unwrap_or(false),
        is_season_pack: is_season_pack_release(&stream.title.clone().unwrap_or_default(), season),
    }
}

fn to_stream_item(stream: &RankingStream) -> crate::contract::StreamItem {
    let title = stream.title.clone();
    let url = stream
        .extra
        .get("url")
        .and_then(|v| v.as_str())
        .map(String::from);
    let resolvido = url.is_some();
    crate::contract::StreamItem {
        name: stream.name.clone(),
        title,
        // Item resolvido pelo debrid leva `url` e perde `infoHash`/`sources`.
        info_hash: if resolvido {
            None
        } else {
            stream.info_hash.clone()
        },
        sources: if resolvido {
            None
        } else {
            stream
                .extra
                .get("sources")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str().map(String::from))
                        .collect()
                })
        },
        behavior_hints: stream
            .extra
            .get("behaviorHints")
            .map(|v| serde_json::from_value(v.clone()).unwrap_or_default()),
        url,
        external_url: None,
        size: stream_size_label(stream.title.as_deref().unwrap_or("")),
    }
}

/// Texto do aviso de lista vazia — os mesmos estados do TS, sem os que exigem
/// estado de fora (probe/autofetch chegam na fatia de integração). `None` =
/// filme sem candidato NÃO promete "reabra" (mentiria).
fn notice_text(ctx: &BuildContext, out: &BuiltList) -> Option<String> {
    if out.candidates_before_debrid > 0 {
        return Some(format!(
            "Nenhuma fonte pronta — {} resultado(s) fora do cache",
            out.candidates_before_debrid
        ));
    }
    if ctx.season.is_some() {
        return Some("Nada pronto ainda — procurando a temporada; reabra em instantes".into());
    }
    None
}

/// `JsText` → `String` do contrato. Astral pareado decodifica exato; surrogate
/// ÓRFÃO vira o escape literal `\udXXX` (a mesma forma do `JSON.stringify` do
/// núcleo) — nada vira U+FFFD e `JsText::from_json_string_literal` devolve o
/// original. O órfão só existe de verdade na travessia Node↔Rust; dentro do
/// pipeline puro-Rust o `JsText` preserva as unidades (contrato de
/// `stream-relabel`/`stream-trace`).
fn js_to_contract_string(text: &JsText) -> String {
    let units = text.as_units();
    let mut out = String::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        if (0xD800..=0xDBFF).contains(&u)
            && units
                .get(i + 1)
                .is_some_and(|&lo| (0xDC00..=0xDFFF).contains(&lo))
        {
            let lo = units[i + 1];
            let cp = 0x1_0000 + ((u as u32 - 0xD800) << 10) + (lo as u32 - 0xDC00);
            if let Some(c) = char::from_u32(cp) {
                out.push(c);
            }
            i += 2;
            continue;
        }
        if (0xD800..=0xDFFF).contains(&u) {
            out.push_str(&format!("\\u{u:04x}"));
        } else if let Some(c) = char::from_u32(u as u32) {
            out.push(c);
        }
        i += 1;
    }
    out
}
