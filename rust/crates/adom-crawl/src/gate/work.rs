//! Resultado de UM post pago, na forma que a ingestão do motor grava.
//! Separado do `gate.rs` pela catraca de 400 linhas.

use crate::motor::types::{CrawlRawItem, CrawlResultStatus, CrawlWorkResult};
use crate::page_engine::kind_from;
use crate::profile_parsers::{release_title, ResolverLink};
use crate::store::ops::GateRow;

/// `CrawlWorkResult` do post pago, com o título da release pela MESMA
/// régua do raspador (`release_title`: post dá nome/ano, magnet completa).
pub(super) fn work_of(g: &GateRow, magnet: &str) -> CrawlWorkResult {
    // Post sem `<h1>` colhido: o magnet (dn=) é a matéria-prima honesta.
    let bruto = if g.title.trim().is_empty() {
        magnet.to_string()
    } else {
        g.title.clone()
    };
    let post_year = (g.year > 0).then_some(g.year as u32);
    let link = ResolverLink {
        url: magnet.to_string(),
        ..Default::default()
    };
    let titulo = release_title(&bruto, post_year, &link, None);
    CrawlWorkResult {
        url: g.row.url.clone(),
        url_key: g.row.url_key.clone(),
        site: g.row.site.clone(),
        status: CrawlResultStatus::Done,
        imdb: (!g.imdb.is_empty()).then(|| g.imdb.clone()),
        title: (!g.title.is_empty()).then(|| g.title.clone()),
        year: (g.year > 0).then_some(g.year),
        kind: kind_from(&g.kind),
        releases: vec![CrawlRawItem {
            title: titulo,
            magnet: Some(magnet.to_string()),
            link: None,
            size: None,
            seeders: None,
            tracker: Some("BLUDV".to_string()),
            // Acervo é BR-dublado e o post é do BLUDV (100% BR).
            is_br: true,
        }],
        groups: Vec::new(),
        unlocated: Vec::new(),
        progress: None,
        // Um pagamento custou um pedido ao solver (régua do `to_work`).
        request_cost: 1,
        error: String::new(),
        gate: None,
    }
}
