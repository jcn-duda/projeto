//! Defaults/parse de env do [`super::JackettCollector`] (extraído pela catraca
//! de 400 linhas). As listas espelham `src/config/jackett.ts`.

/// Defaults alinhados a `src/config/jackett.ts` (`JACKETT_INDEX_ONLY_INDEXERS`).
pub(super) fn default_index_only_indexers() -> Vec<String> {
    split_csv(
        "redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann,magnetdownload,1337x,kickasstorrents-ws",
    )
}

/// Default de `JACKETT_LIVE_EXEMPT_INDEXERS` no Node (apachetorrent-cardigann).
/// A exceção vence o index-only SÓ na presença ao vivo.
pub(super) fn default_live_exempt_indexers() -> Vec<String> {
    split_csv("apachetorrent-cardigann")
}

/// `TITLE_PRECISION_TAIL_CUT`: só "false" (após trim) desliga; default true.
pub(super) fn parse_title_precision_tail_cut(raw: &str) -> bool {
    raw.trim() != "false"
}

pub(super) fn split_csv(raw: &str) -> Vec<String> {
    let ids: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    // Rename dos ids aposentados (mesmo mapa do TS): `JACKETT_INDEX_ONLY_INDEXERS`
    // e `JACKETT_LIVE_EXEMPT_INDEXERS` são as MESMAS envs que o Node lê, então
    // os dois lados precisam casar o mesmo id.
    adom_core::rename_indexer_ids(&ids)
}
