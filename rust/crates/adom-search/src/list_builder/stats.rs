//! Linha de estatísticas do título e as réguas de exibição do
//! `toStremioStream` (tracker e fonte), extraídas de `helpers.rs` pela catraca
//! de 400 linhas.

use adom_core::{bytes_to_size, magnet_display_name, source_from_title};

use crate::raw_item::RawItem;

/// Rótulo do tracker (`item.tracker || item.Tracker || item.Indexer ||
/// item.indexer`): o nome que o Jackett publica ("Rede Torrent"), não o id
/// do indexer ("redetorrent"), que fica para cotas e prioridade.
pub fn display_tracker(item: &RawItem) -> Option<&str> {
    item.tracker
        .as_deref()
        .or(item.indexer.as_deref())
        .filter(|s| !s.is_empty())
}

/// Fonte da mídia: o `dn=` do magnet preserva o nome REAL do release quando o
/// título do post o esconde, e CAM no magnet vence o silêncio do título;
/// sem nada nos dois, a fonte gravada no índice (`mediaSource`).
pub fn display_source(item: &RawItem, title: &str) -> String {
    let dn = magnet_display_name(
        item.magnet.as_deref(),
        item.magnet_uri.as_deref(),
        item.guid.as_deref(),
    );
    let from_title = source_from_title(title);
    let from_magnet = source_from_title(&dn);
    if from_magnet == "CAM" && from_title != "CAM" {
        return from_magnet.to_string();
    }
    [
        from_title,
        from_magnet,
        item.media_source.as_deref().unwrap_or(""),
    ]
    .into_iter()
    .find(|s| !s.is_empty())
    .unwrap_or("")
    .to_string()
}

/// Linha de estatísticas do título (`👤 N 💾 X ⚙️ T`), como o `toStremioStream`.
pub fn stats_line(item: &RawItem) -> String {
    let mut parts: Vec<String> = Vec::new();
    // Dado salvo (reserva do banco ou foto do índice): 📦 e seeders `~N` — é
    // foto do acervo, não medição viva (o `stored` do `toStremioStream`).
    let stored = item.from_fallback || item.from_snapshot;
    if stored {
        parts.push("📦".into());
    }
    let n = item.seeders.unwrap_or(0.0);
    let count = if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    };
    if stored {
        parts.push(if n > 0.0 {
            format!("👤 ~{count}")
        } else {
            "👤 ~".into()
        });
    } else {
        // O TS publica `👤 ${seeders}` SEMPRE (inclusive `👤 0`): sem esta
        // linha o título perdia o separador `\n` e o cliente não mostrava o
        // zero medido.
        parts.push(format!("👤 {count}"));
    }
    if let Some(bytes) = item.size_bytes.filter(|b| *b > 0.0) {
        if let Some(label) = bytes_to_size(bytes) {
            parts.push(format!("💾 {label}"));
        }
    }
    if let Some(tracker) = display_tracker(item) {
        parts.push(format!("⚙️ {tracker}"));
    }
    parts.join(" ")
}
