//! Linha de estatísticas do título (`👤 N 💾 X`), extraída de `helpers.rs`
//! pela catraca de 400 linhas.

use adom_core::bytes_to_size;

use crate::raw_item::RawItem;

/// Linha de estatísticas do título (`👤 N 💾 X`), como o `toStremioStream`.
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
    } else if n > 0.0 {
        parts.push(format!("👤 {count}"));
    }
    if let Some(bytes) = item.size_bytes.filter(|b| *b > 0.0) {
        if let Some(label) = bytes_to_size(bytes) {
            parts.push(format!("💾 {label}"));
        }
    }
    parts.join(" ")
}
