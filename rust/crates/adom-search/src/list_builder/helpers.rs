use super::audio_proof::{audio_proof, origin_is_br, AudioAudit};
pub use super::stats::{display_source, display_tracker, stats_line};
use super::types::{self, BuildContext, BuildOptions, WorkHint};
use crate::raw_item::RawItem;
use adom_core::{
    edition_from_title, is_season_pack_release, quality_from_title, stream_display_name,
    stream_size_label, strip_quality_tag_blob, JsText, PoolStream, RankingStream,
    StreamDisplayConfig, StreamDisplayOptions, StreamRef,
};

/// Extensões executáveis do corte de release falsa (corte 1 de
/// `fake-release.ts`; o corte 2 do irmão depende do acervo — bases injetadas).
pub const EXECUTABLE_EXTS: [&str; 8] = [
    ".exe", ".scr", ".lnk", ".bat", ".cmd", ".msi", ".pif", ".vbs",
];

/// O título ou o `dn=` declara um executável? A extensão fecha o nome ou vem
/// antes de espaço/colchete/parêntese/pontuação — `DVDSCR` e `site.com` não
/// casam.
pub fn is_executable_release(title: &str, dn: &str) -> bool {
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
pub fn fake_release_base(title: &str) -> String {
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

pub fn drop_fake_releases(raw: Vec<RawItem>, ctx: &BuildContext) -> Vec<RawItem> {
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

pub fn first_year(year: &str) -> i64 {
    year.chars()
        .collect::<Vec<_>>()
        .windows(4)
        .find_map(|w| w.iter().collect::<String>().parse::<i64>().ok())
        .unwrap_or(0)
}

pub fn work_hint_of(ctx: &BuildContext) -> Option<WorkHint> {
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
pub fn pre_air_hashes(raw: &[RawItem], ctx: &BuildContext, opts: &BuildOptions) -> Vec<String> {
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
pub fn map_stream(
    item: &RawItem,
    display: &StreamDisplayConfig,
    audit: &AudioAudit,
) -> Option<RankingStream> {
    let hash = item.hash();
    if hash.is_empty() {
        return None;
    }
    let title = item.title_text().to_string();
    // O blob do HDRTorrent descreve TODAS as opções do post, não esta release:
    // o TS exibe `stripQualityTagBlob(title)` no `title` e no `name`, mas lê a
    // QUALIDADE do título cru (o classificador já corta o blob por dentro).
    // Exibir limpo não muda o ranking — `quality_from_title` segue igual.
    let display_title = strip_quality_tag_blob(&title);
    let br = origin_is_br(item, &title, audit);
    let proof = audio_proof(item, &title, br, audit);
    // O nome do arquivo é fato; o título do post, palpite (`provenQuality`).
    let quality = item
        .proven_quality
        .clone()
        .unwrap_or_else(|| quality_from_title(&title).to_string());
    let source = display_source(item, &title);
    let stats = stats_line(item);
    let full_title = if stats.is_empty() {
        display_title.to_string()
    } else {
        format!("{display_title}\n{stats}")
    };
    let name_text = stream_display_name(
        &StreamDisplayOptions {
            title: Some(display_title),
            quality: Some(&quality),
            audio: Some(&proof.chip_audio),
            source: Some(&source),
            edition: Some(edition_from_title(&title)),
            tracker: display_tracker(item),
            is_br: br,
            seeders: Some(&types::seeders_value_of(item.seeders)),
            // `stored` do TS: foto do índice exibe o MESMO selo da reserva.
            from_fallback: item.from_fallback || item.from_snapshot,
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
        dubbed: Some(proof.dubbed),
        dub_claim: Some(proof.dub_claim),
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
    // Marca de reserva do bank/foto do índice: o `finish` lê daqui para o
    // `hasFallback` (entrada com reserva nunca é completa). Não é campo `_*`
    // do contrato: `to_stream_item` não a copia.
    if item.broken {
        stream.extra.insert("_broken".into(), true.into());
    }
    if item.from_fallback {
        stream.extra.insert("_fromFallback".into(), true.into());
        // Ponte com o Chupim: o `toRawItem` do Node põe `fallbackFetchable` e
        // o pool lê `_fallbackFetchable` (autofetch-pools). Hunk do fallback F1.
        if item
            .extra
            .get("fallbackFetchable")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            stream
                .extra
                .insert("_fallbackFetchable".into(), true.into());
        }
        // Dublado que só o banco sabe: o classificador da captura marcou
        // `dubbed=1` mesmo sem o título citar áudio. `ranking_to_pool` lê
        // `bankDub` para a vaga BR e o pool do Chupim (card irmão do
        // `_bankDub` do TS, que sai antes do protocolo).
        if proof.bank_dub {
            stream.extra.insert("bankDub".into(), true.into());
        }
    }
    // Foto do índice: o `finish` também a conta como reserva na lista (TTL
    // curto), igual ao `fallbackInList` do TS.
    if item.from_snapshot {
        stream.extra.insert("_fromSnapshot".into(), true.into());
    }
    Some(stream)
}

pub fn ranking_to_pool(stream: &RankingStream) -> PoolStream {
    // `map_stream` grava as chaves CANÔNICAS com underscore (`_fromFallback`,
    // `_fallbackFetchable`), que são as que o contrato trata como internas. O
    // sem-underscore fica só como compatibilidade de produtores antigos; sem
    // ler a canônica, `fallback_blocked`/vagas BR nunca enxergam a reserva 📦.
    let flag = |canonical: &str, legacy: &str| {
        stream
            .extra
            .get(canonical)
            .or_else(|| stream.extra.get(legacy))
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    };
    let from_fallback = flag("_fromFallback", "fromFallback");
    let fallback_fetchable = flag("_fallbackFetchable", "fallbackFetchable");
    PoolStream {
        info_hash: stream.info_hash.clone(),
        title: stream.title.clone(),
        name: stream.name.clone(),
        quality: stream.quality.clone(),
        seeders: stream.seeders.map(|n| n as i64),
        is_br: stream.br.unwrap_or(false),
        is_dubbed: stream.dubbed.unwrap_or(false),
        is_dub_claim: stream.dub_claim.unwrap_or(false),
        is_bank_dub: flag("bankDub", "_bankDub"),
        is_lied: stream.lied.unwrap_or(false),
        from_fallback,
        fallback_fetchable,
    }
}

pub fn stream_to_ref(stream: &RankingStream, season: Option<i64>) -> StreamRef {
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

pub fn to_stream_item(stream: &RankingStream) -> crate::contract::StreamItem {
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
pub fn notice_text(ctx: &BuildContext, out: &super::types::BuiltList) -> Option<String> {
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
pub fn js_to_contract_string(text: &JsText) -> String {
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
