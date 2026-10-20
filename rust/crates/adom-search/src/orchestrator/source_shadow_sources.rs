//! Parsing PURO de `SOURCES_RUST_SHADOW`/`SOURCES_RUST` e capacidades por
//! fonte (extraído de `source_shadow.rs` pela catraca de 400 linhas).
//!
//! Fonte com sombra precisa da MESMA identidade de indexer do Node (F2.1
//! Jackett, F2.2 Prowlarr, F2.3 Torrentio, F2.4 Mico, F2.5 BLUDV). BLUDV tem
//! identidade desde o C3 (`tracker: "BLUDV"` → `_indexer: "bludv"`).

/// Fontes com sombra: todas as que já têm identidade de indexer normalizada em
/// relação ao Node (inclui BLUDV: sem `indexer`, mas o `tracker` é o id).
pub(super) const SHADOW_SOURCES: &[&str] = &["jackett", "prowlarr", "torrentio", "mico", "bludv"];

/// O Node promete contrato de `live` para esta fonte? Jackett (por indexer) e
/// Mico (`noteStart(["mico"])` + `onQueryResult` no `collectRawLive`). Prowlarr,
/// Torrentio e BLUDV não atravessam o snapshot (o `prowlarr.search`/
/// `torrentio.search`/`bludv.search` do TS não têm `onQueryResult`), então o
/// live nativo deles não tem referência para comparar — seria divergência
/// falsa toda vez que falhassem.
pub(super) fn has_live_reference(source: &str) -> bool {
    matches!(source, "jackett" | "mico")
}

/// Fontes pedidas pela sombra, já excluindo as que estão em `SOURCES_RUST`
/// (puro - testável sem tocar no env do processo).
pub fn shadow_sources(shadow_raw: &str, sources_raw: &str) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for token in shadow_raw.split(',') {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let Some(source) = SHADOW_SOURCES
            .iter()
            .copied()
            .find(|known| known.eq_ignore_ascii_case(token))
        else {
            // Token desconhecido: não é fonte do Node (nada roda por ele).
            continue;
        };
        if out.contains(&source) {
            continue;
        }
        if csv_includes(sources_raw, source) {
            continue;
        }
        out.push(source);
    }
    out
}

/// Tokens de `SOURCES_RUST_SHADOW` que NÃO entram na sombra (fora do recorte ou
/// já migrados). Só para o log de boot — nada roda por eles.
pub(super) fn ignored_shadow_tokens(shadow_raw: &str, sources_raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for token in shadow_raw.split(',') {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let accepted = SHADOW_SOURCES
            .iter()
            .any(|known| known.eq_ignore_ascii_case(token));
        if !accepted || csv_includes(sources_raw, token) {
            out.push(token.to_string());
        }
    }
    out
}

fn csv_includes(raw: &str, token: &str) -> bool {
    raw.split(',')
        .any(|item| item.trim().eq_ignore_ascii_case(token))
}
