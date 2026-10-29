//! Regras PURAS da captura do acervo: `inputFromItem` + `mergeMagnet`/
//! `mergeSource` (`src/utils/magnet-bank-merge.ts`) e o roteamento de obras
//! (`releaseWorkTargets`).
//!
//! Separado da escrita (`magnet_bank_write.rs`) pela catraca de 400 linhas:
//! aqui não há SQL — só a decisão de QUAL linha gravar. A transação, o CAS de
//! `magnet_work` e o `INSERT` ficam lá.
//!
//! Regras que não podem se perder no porte (a especificação do banco vivo):
//! `first_seen` é fixo; `seeders_max` é máximo e `seeders_last` é a última
//! observação (item sem número PRESERVA a anterior, `0` explícito é medição);
//! `is_br`/`dubbed`/`lied` só sobem (OR); a `uri` só troca por outra MAIS RICA
//! (`dn=` ou mais trackers); o `title` troca só para ganhar o episódio que
//! faltava; `passed_filter` NÃO é OR (é a última observação da obra).

use adom_core::{
    audio_from_title, default_magnet, explicit_pt_audio, parse_title_season_episode,
    quality_from_title, sanitize_magnet, source_from_title, UNKNOWN_QUALITY,
};
use adom_search::RawItem;

use super::write::hash_of;

/// Uma observação da leva, pronta para o `INSERT` em `magnet` (`MagnetInput`).
///
/// `seeders_last` é `Option` de propósito: `None` = "o item não trouxe número"
/// (o merge preserva a última medição), distinto de `0`, que é observação.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct CaptureRow {
    pub hash: String,
    pub uri: String,
    pub title: String,
    pub size: i64,
    pub is_br: i64,
    pub dubbed: i64,
    pub lied: i64,
    pub quality: String,
    pub seeders_max: i64,
    pub seeders_last: Option<i64>,
    /// Grupo da fonte (`indexer || tracker`), o `indexer` de `magnet_source`.
    pub indexer: String,
    pub tracker: String,
}

/// Uma fonte da leva, pronta para o `INSERT` em `magnet_source` (`SourceInput`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct SourceRow {
    pub hash: String,
    pub indexer: String,
    pub tracker: String,
    pub seeders_last: Option<i64>,
}

/// `parseSeeders`: ausente/não finito = `None` (preserva a última observação).
fn seeders_of(item: &RawItem) -> Option<i64> {
    item.seeders
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value as i64)
}

/// `classifiedDubbed`: "dublado" pela PROMESSA do título — em site BR o rótulo
/// de áudio (Dublado/Dual/Nacional); fora deles só PT explícito (DUAL de cena
/// gringa não é dublagem).
pub(super) fn classified_dubbed(title: &str, is_br: bool) -> bool {
    if is_br {
        matches!(audio_from_title(title), "Dublado" | "Dual" | "Nacional")
    } else {
        explicit_pt_audio(title)
    }
}

/// `knownQuality`: "sem resolução" é AUSÊNCIA, não medição — não bloqueia a
/// qualidade real que chega depois.
fn known_quality(quality: &str) -> &str {
    if quality.is_empty() || quality == UNKNOWN_QUALITY {
        ""
    } else {
        quality
    }
}

/// Presença de `dn=` e contagem de trackers — a régua de "URI mais rica"
/// (`/[?&]dn=[^&]/` e `/[?&]tr=/g` do TS).
fn uri_shape(uri: &str) -> (bool, usize) {
    let has_dn = ["?dn=", "&dn="].iter().any(|needle| {
        uri.match_indices(needle).any(|(at, _)| {
            uri[at + needle.len()..]
                .chars()
                .next()
                .is_some_and(|c| c != '&')
        })
    });
    (
        has_dn,
        uri.matches("?tr=").count() + uri.matches("&tr=").count(),
    )
}

/// `isRicherUri`: a nova URI só substitui a guardada quando tem `dn=` (a antiga
/// não) ou mais trackers. Empate mantém a guardada — a primeira evidência vence
/// e o `defaultMagnet` (só o piso) nunca rebaixa uma URI do post.
pub(super) fn is_richer_uri(next: &str, prev: &str) -> bool {
    if prev.is_empty() {
        return !next.is_empty();
    }
    if next.is_empty() || next == prev {
        return false;
    }
    let (next_dn, next_trackers) = uri_shape(next);
    let (prev_dn, prev_trackers) = uri_shape(prev);
    if next_dn != prev_dn {
        return next_dn;
    }
    next_trackers > prev_trackers
}

/// `episodeUpgrade`: o título só troca quando o novo NOMEIA o episódio que o
/// antigo calava — é o mesmo hash rotulado com mais precisão. Sem isto o botão
/// visto antes do parser ler "EPISÓDIOS 03" ficava "1ª Temporada" para sempre e
/// o acervo o servia como pack em todo episódio.
pub(super) fn episode_upgrade(prev: &str, next: &str) -> bool {
    if prev.is_empty() || next.is_empty() || prev == next {
        return false;
    }
    let before = parse_title_season_episode(prev);
    let after = parse_title_season_episode(next);
    before.episodes.is_empty() && !after.episodes.is_empty()
}

/// `magnetUriOf`: primeiro candidato que É magnet (`magnet:`).
fn magnet_uri_of(item: &RawItem) -> &str {
    [
        item.magnet.as_deref(),
        item.magnet_uri.as_deref(),
        item.guid.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find(|uri| uri.starts_with("magnet:"))
    .unwrap_or("")
}

/// Grupo da fonte: `indexer || tracker`, minúsculo e cortado em 64; vazio cai
/// em `all` (o default do `inputFromItem`).
///
/// `source` é o `groupIndexer` do Node e tem precedência; a busca NATIVA passa
/// VAZIO de propósito — o grupo sai do próprio item. Preencher por omissão
/// (ex.: "jackett") jogaria BLUDV/Torrentio/Prowlarr no balde errado e a coluna
/// `indexer` do acervo (painel por indexer e filtro `ji`) passaria a mentir.
pub(super) fn capture_group(item: &RawItem, source: &str) -> String {
    let raw = std::iter::once(source)
        .chain(
            [item.indexer.as_deref(), item.tracker.as_deref()]
                .into_iter()
                .flatten(),
        )
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or("");
    let group: String = raw.to_lowercase().chars().take(64).collect();
    if group.is_empty() {
        "all".into()
    } else {
        group
    }
}

/// `inputFromItem`: item cru → linha de acervo. `None` para item de CONTA, de
/// RESERVA, FOTO do índice e item sem hash — nenhum dos três é observação do
/// site e todos se perpetuariam (o merge renovaria `lastSeen`/`seedersLast` e o
/// banco passaria a "provar" um frescor que não houve).
pub(super) fn capture_row(item: &RawItem, source: &str) -> Option<CaptureRow> {
    if item.from_account || item.from_fallback || item.from_snapshot {
        return None;
    }
    let hash = hash_of(&item.to_wire());
    if hash.is_empty() {
        return None;
    }
    // Sempre há URI: quando o post só rende o padrão, o `default_magnet` é
    // gravado assim mesmo para o clone ser total (o play remonta pelo magnetFor).
    let raw_uri = magnet_uri_of(item);
    let uri = if raw_uri.is_empty() {
        None
    } else {
        sanitize_magnet(Some(raw_uri), &hash)
    }
    .unwrap_or_else(|| default_magnet(&hash));
    let post_title = item.title_text().to_string();
    let dn = item.dn();
    // O `dn=` do magnet vence o palpite do WordPress quando PROVA CAM: sem
    // isso o item servido do acervo perde a marca e o `excludeCam` não corta.
    let title = if !dn.is_empty()
        && source_from_title(&dn) == "CAM"
        && source_from_title(&post_title) != "CAM"
    {
        dn
    } else {
        post_title.clone()
    };
    let seeders = seeders_of(item);
    Some(CaptureRow {
        hash,
        uri,
        title,
        size: item
            .size_bytes
            .filter(|bytes| bytes.is_finite() && *bytes > 0.0)
            .map(|bytes| bytes as i64)
            .unwrap_or(0),
        is_br: i64::from(item.is_br),
        dubbed: i64::from(classified_dubbed(&post_title, item.is_br)),
        lied: i64::from(item.lied),
        quality: known_quality(quality_from_title(&post_title)).to_string(),
        seeders_max: seeders.unwrap_or(0),
        seeders_last: seeders,
        indexer: capture_group(item, source),
        tracker: item.tracker.clone().unwrap_or_default(),
    })
}

/// A fonte da linha capturada (`SourceInput`): hash + grupo + tracker + seeders.
pub(super) fn source_row(row: &CaptureRow) -> SourceRow {
    SourceRow {
        hash: row.hash.clone(),
        indexer: row.indexer.clone(),
        tracker: row.tracker.clone(),
        seeders_last: row.seeders_last,
    }
}

/// `mergeInputs`: duas capturas do MESMO hash na leva (hash repetido entre
/// indexers). A URI mais rica vence, título/tamanho ficam os primeiros não
/// vazios, as flags sobem (OR) e `seeders_last` é a última observação numérica.
pub(super) fn merge_inputs(prev: CaptureRow, next: CaptureRow) -> CaptureRow {
    CaptureRow {
        hash: prev.hash,
        uri: if is_richer_uri(&next.uri, &prev.uri) {
            next.uri
        } else {
            prev.uri
        },
        title: if prev.title.is_empty() {
            next.title
        } else {
            prev.title
        },
        size: if prev.size != 0 { prev.size } else { next.size },
        is_br: prev.is_br.max(next.is_br),
        dubbed: prev.dubbed.max(next.dubbed),
        lied: prev.lied.max(next.lied),
        quality: if prev.quality.is_empty() {
            next.quality
        } else {
            prev.quality
        },
        seeders_max: prev.seeders_max.max(next.seeders_max),
        seeders_last: next.seeders_last.or(prev.seeders_last),
        indexer: prev.indexer,
        tracker: if prev.tracker.is_empty() {
            next.tracker
        } else {
            prev.tracker
        },
    }
}

/// `mergeMagnet`: observação da leva contra a linha JÁ GRAVADA em `magnet`.
///
/// É o único merge que difere de [`merge_inputs`]: aqui o título troca pelo
/// `episodeUpgrade` (a linha antiga calava o episódio e a nova o nomeia).
/// `last_seen`/`first_seen` não moram no `CaptureRow` — quem os aplica é o SQL
/// do upsert (`MAX`/fixo).
pub(super) fn merge_stored(prev: CaptureRow, next: CaptureRow) -> CaptureRow {
    let title = if episode_upgrade(&prev.title, &next.title) || prev.title.is_empty() {
        next.title
    } else {
        prev.title
    };
    CaptureRow {
        hash: prev.hash,
        uri: if is_richer_uri(&next.uri, &prev.uri) {
            next.uri
        } else {
            prev.uri
        },
        title,
        size: if prev.size != 0 { prev.size } else { next.size },
        is_br: prev.is_br.max(next.is_br),
        dubbed: prev.dubbed.max(next.dubbed),
        lied: prev.lied.max(next.lied),
        quality: if prev.quality.is_empty() {
            next.quality
        } else {
            prev.quality
        },
        seeders_max: prev.seeders_max.max(next.seeders_max),
        seeders_last: next.seeders_last.or(prev.seeders_last),
        indexer: prev.indexer,
        tracker: if prev.tracker.is_empty() {
            next.tracker
        } else {
            prev.tracker
        },
    }
}

/// `mergeSourceInput`: duas fontes do MESMO par (hash, indexer) na leva.
pub(super) fn merge_source(prev: SourceRow, next: &SourceRow) -> SourceRow {
    SourceRow {
        hash: prev.hash,
        indexer: prev.indexer,
        tracker: if prev.tracker.is_empty() {
            next.tracker.clone()
        } else {
            prev.tracker
        },
        seeders_last: next.seeders_last.or(prev.seeders_last),
    }
}
