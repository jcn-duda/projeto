use super::audio_proof::{audio_proof, origin_is_br, AudioAudit};
use super::helpers::{js_to_contract_string, DEFAULT_TRACKERS};
use super::stats::{display_source, display_tracker, stats_line};
use super::types;
use crate::raw_item::RawItem;
use adom_core::{
    edition_from_title, is_multi_work_collection, quality_from_title, stream_display_name,
    stream_size_label, strip_quality_tag_blob, RankingStream, StreamDisplayConfig,
    StreamDisplayOptions,
};

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
    // `_indexer` do Node (`String(item.indexer || tracker || '').trim().toLowerCase()`):
    // é o id que as cotas por indexador e a prioridade comparam. O `item.indexer`
    // pode faltar (fonte que só publica o label) ou vir com caixa/espaço.
    let indexer = item
        .indexer
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| display_tracker(item))
        .map(|s| s.trim().to_lowercase());
    // `_tracker`/`_magnetDn` do `toStremioStream`: o dedupe remonta o `name` no
    // `relabel` e lê os DOIS do VENCEDOR. Sem eles aqui, o vencedor trocado por
    // qualidade herdada perdia o rótulo do tracker na coluna estreita (e o CAM
    // do `dn=` sumia do `excludeCam`).
    let magnet_dn = {
        let dn = item.dn();
        if !dn.is_empty() {
            dn
        } else if source == "CAM" {
            "CAMRip".to_string()
        } else {
            String::new()
        }
    };
    let mut stream = RankingStream {
        info_hash: Some(hash),
        title: Some(full_title),
        name: Some(js_to_contract_string(&name_text)),
        quality: Some(quality.clone()),
        seeders: item.seeders,
        size: item.size_bytes,
        bytes: item.size_bytes,
        br: Some(br),
        dubbed: Some(proof.dubbed),
        dub_claim: Some(proof.dub_claim),
        indexer,
        tracker: display_tracker(item).map(str::to_string),
        magnet_dn: Some(magnet_dn),
        lied: item.lied.then_some(true),
        // `_multiWork` do `toStremioStream`: coleção detectada pelo título OU
        // pack admitido. A marca é GENÉRICA de propósito — o `/resolve` só
        // precisa saber que o torrent pode conter mais de uma obra; quem decide
        // se o pack pode ser oferecido é `multi_work_admitted` (playDisposition).
        multi_work: Some(is_multi_work_collection(&title) || item.multi_work_admitted),
        multi_work_admitted: item.multi_work_admitted.then_some(true),
        // `bingeGroup` do Node (`search-names.ts`): episódios da MESMA release
        // tocam em sequência no Stremio. Sem isto o nativo omitia o campo.
        behavior_hints: Some(serde_json::json!({
            "bingeGroup": format!(
                "powerm-{}-{}",
                if quality == adom_core::UNKNOWN_QUALITY { "na" } else { quality.as_str() },
                if source.is_empty() { "any" } else { source.as_str() },
            ),
        })),
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
            Some(
                DEFAULT_TRACKERS
                    .iter()
                    .map(|tracker| format!("tracker:{tracker}"))
                    .collect(),
            )
        },
        behavior_hints: stream
            .behavior_hints
            .clone()
            .and_then(|value| serde_json::from_value(value).ok()),
        url,
        external_url: None,
        size: stream_size_label(stream.title.as_deref().unwrap_or("")),
    }
}
