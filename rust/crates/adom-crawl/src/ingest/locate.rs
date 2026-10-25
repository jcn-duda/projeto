//! Locação da página: os grupos viram `(temporada, episódio)` e a release crua
//! vira o `RawItem` que o banco vivo e o índice consomem.
//!
//! É o `toRawItem` + o laço de grupos de `src/routes/internal-crawl-result.ts`:
//! grupos primeiro, depois as releases avulsas na raiz; `unlocated` NÃO é
//! gravado (sem temporada não há locação para indexar).

use adom_core::{extract_info_hash, WorkTarget};
use adom_search::RawItem;

use super::location_target;
use crate::motor::types::{CrawlRawItem, CrawlWorkResult};

/// UMA gravação: a locação e as releases daquela página/grupo.
#[derive(Debug, Clone, Copy)]
pub struct PageLocation<'a> {
    pub target: WorkTarget,
    pub releases: &'a [CrawlRawItem],
}

/// Locações de uma página, na ordem do Node: grupos (locação declarada) e
/// depois as releases avulsas na raiz. Grupo vazio fica de fora.
pub fn page_locations(page: &CrawlWorkResult) -> Vec<PageLocation<'_>> {
    let mut out = Vec::new();
    for group in &page.groups {
        if group.releases.is_empty() {
            continue;
        }
        out.push(PageLocation {
            target: location_target(group.season, group.episode),
            releases: &group.releases,
        });
    }
    if !page.releases.is_empty() {
        out.push(PageLocation {
            target: WorkTarget {
                season: None,
                episode: None,
            },
            releases: &page.releases,
        });
    }
    out
}

/// `hasReleasesToRecord` da rota: sem nada a gravar não se gasta identificação.
pub fn has_releases_to_record(page: &CrawlWorkResult) -> bool {
    page.groups.iter().any(|group| !group.releases.is_empty()) || !page.releases.is_empty()
}

/// `toRawItem(site, r)`: `indexer` é o SITE (a cota do índice), `tracker` é o
/// rótulo de exibição, o hash sai do magnet e o tamanho do rótulo textual.
pub fn raw_item(site: &str, release: &CrawlRawItem) -> RawItem {
    let magnet = release
        .magnet
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    RawItem {
        title: non_empty(&release.title),
        magnet: magnet.map(str::to_string),
        info_hash: magnet.and_then(extract_info_hash),
        seeders: release.seeders.map(f64::from),
        size_bytes: release.size.as_deref().and_then(parse_size_bytes),
        indexer: non_empty(site),
        tracker: release.tracker.clone().filter(|text| !text.is_empty()),
        is_br: release.is_br,
        ..RawItem::default()
    }
}

/// Lote da locação no formato cru do banco/índice.
pub fn raw_items(site: &str, releases: &[CrawlRawItem]) -> Vec<RawItem> {
    releases
        .iter()
        .map(|release| raw_item(site, release))
        .collect()
}

fn non_empty(text: &str) -> Option<String> {
    (!text.is_empty()).then(|| text.to_string())
}

/// Multiplicadores do `parseSizeBytes` do TS (base 1024).
const SIZE_UNITS: [(&str, f64); 4] = [
    ("KB", 1024.0),
    ("MB", 1_048_576.0),
    ("GB", 1_073_741_824.0),
    ("TB", 1_099_511_627_776.0),
];

fn is_size_char(byte: u8) -> bool {
    byte.is_ascii_digit() || byte == b'.' || byte == b','
}

fn unit_at(rest: &[u8]) -> Option<f64> {
    for (unit, multiplier) in SIZE_UNITS {
        let unit = unit.as_bytes();
        if rest.len() >= unit.len() && rest[..unit.len()].eq_ignore_ascii_case(unit) {
            return Some(multiplier);
        }
    }
    None
}

/// `parseSizeBytes` (`src/routes/internal-crawl-result.ts`): primeiro rótulo
/// `([\d.,]+)\s*(TB|GB|MB|KB)` do texto, vírgula decimal trocada por ponto e
/// `Math.round`. `None` quando não há rótulo ou o número não é finito
/// (`"1.234,5 GB"` → `NaN` no TS, como aqui).
pub fn parse_size_bytes(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut start = 0;
    while start < bytes.len() {
        if !is_size_char(bytes[start]) {
            start += 1;
            continue;
        }
        let mut end = start;
        while end < bytes.len() && is_size_char(bytes[end]) {
            end += 1;
        }
        let mut after = end;
        while after < bytes.len() && bytes[after].is_ascii_whitespace() {
            after += 1;
        }
        if let Some(multiplier) = unit_at(&bytes[after..]) {
            let number = text[start..end].replacen(',', ".", 1);
            let Ok(value) = number.parse::<f64>() else {
                return None;
            };
            return value.is_finite().then(|| (value * multiplier).round());
        }
        start = end;
    }
    None
}
