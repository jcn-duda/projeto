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

/// `JACKETT_INDEX_ONLY_INDEXERS` — `env || default` do Node: o gate é a string
/// CRUA. Ausente e `''` são falsy e caem no default; `'   '` é TRUTHY e o
/// `list()` do TS apara para `[]`, então também aqui vira lista VAZIA.
///
/// Mesma régua de `harvest/drain_shape.rs::index_only_from` e de
/// `stream_config.rs::indexer_list`: com `'   '` o default NUNCA volta, senão a
/// sonda fica sem alvo enquanto a busca viva exclui o default
/// (`no-intersection` silencioso).
pub(super) fn index_only_from(raw: Option<&str>) -> Vec<String> {
    match raw {
        None | Some("") => default_index_only_indexers(),
        Some(value) => split_csv(value),
    }
}

/// `JACKETT_LIVE_EXEMPT_INDEXERS` — `??` do Node: env PRESENTE manda, mesmo
/// vazia ou só espaços (split → lista vazia = kill-switch). Só a AUSÊNCIA cai
/// no default.
pub(super) fn live_exempt_from(raw: Option<&str>) -> Vec<String> {
    match raw {
        Some(value) => split_csv(value),
        None => default_live_exempt_indexers(),
    }
}

/// `TITLE_PRECISION_TAIL_CUT`: só "false" (após trim) desliga; default true.
pub(super) fn parse_title_precision_tail_cut(raw: &str) -> bool {
    raw.trim() != "false"
}

/// Ponte de PARIDADE das réguas de env (`doc(hidden)`): os vetores crus dos
/// três casos que o oráculo TS distingue, sem ler `std::env`. Existe para o
/// teste de paridade do `adom-server` (`harvest/drain_shape.rs`) comparar as
/// duas cópias da MESMA régua — cada lado testava só a sua e a divergência de
/// `"   "` (default de um lado, lista vazia do outro) passou por isso.
///
/// `[ausente, "", "   "]`.
#[doc(hidden)]
pub fn env_parity_probe() -> ([Vec<String>; 3], [Vec<String>; 3]) {
    (
        [
            index_only_from(None),
            index_only_from(Some("")),
            index_only_from(Some("   ")),
        ],
        [
            live_exempt_from(None),
            live_exempt_from(Some("")),
            live_exempt_from(Some("   ")),
        ],
    )
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
