//! Vaca Torrent (`resolvers/profiles/vacatorrent*.ts`): botões do post, título da
//! release e página do Cardigann. Formas de página em `vacatorrent_shapes.rs` e a
//! busca JSON em `vacatorrent_search.rs`.
//!
//! Este arquivo é só o ADAPTADOR de site: liga o núcleo compartilhado
//! (`crate::common::vaca`, o mesmo que o raspador `adom-crawl` consome) ao contrato
//! `SiteOutput`. As regras moravam aqui e eram uma segunda cópia das do raspador —
//! é exatamente assim que os dois lados divergiam em silêncio; agora existe uma
//! implementação só, e ela fica em `adom-crawl/src/br_core/vaca.rs`.
//!
//! Paridade com o JS (preservada no núcleo, com as linhas de autoridade): `\b` é
//! ASCII (`(?-u:\b)` / `FB`), e as diferenças vivas dos cards ficam de pé — fonte
//! `BLRAY`, pack com `\bbatch\b`, faixa com `[.\-s]*`, título sem faixa de
//! episódio, e o desempate de episódio com o `matchAll` cru que LANÇA (vira `Err`
//! e derruba o post inteiro).

use adom_crawl::profile_parsers::ResolverLink;
use adom_crawl::resolver_text::escape_html;

use super::SiteOutput;
use crate::common::vaca::{post_links, VACA_TITLE};
use crate::common::{release_title, search_page_html, SearchItem, SitePost};

pub use crate::common::vaca::{clean_mark_title, VacaParseOptions};

#[path = "vacatorrent_protector.rs"]
pub mod protector;
#[path = "vacatorrent_search.rs"]
mod search;
#[path = "vacatorrent_shapes.rs"]
mod shapes;

pub use search::{parse_search_json, unwrap_search_json, VacaWork};
pub use shapes::{
    decode_data_u, extract_batch_title, extract_movie_links, filter_season_cards, is_watch_anchor,
    normalize_batch_title, normalize_episode_markup, parse_season_internal,
    repair_mangled_entities, series_season_internal_url, VacaSeasonCard,
};

pub struct Vaca;

pub static VACA: Vaca = Vaca;

/// `parseDownloadLinks(html, baseUrl, options)` (`vacatorrent-parsers.ts:319-323`)
/// com a URL do post como base. `Err` é o `throw` do desempate que o TS deixa
/// subir: o post inteiro não produz botões, não uma lista parcial.
pub fn post_links_with(
    html: &str,
    post_url: &str,
    opts: &VacaParseOptions,
) -> Result<Vec<ResolverLink>, String> {
    // `None` no regador = a régua default do profile (base + `systemtech.space`).
    post_links(html, Some(post_url), opts, None)
}

impl SiteOutput for Vaca {
    fn routes(&self) -> crate::server::RouteSet {
        crate::server::RouteSet {
            resolve: true,
            dl: false,
            api: false,
        }
    }

    fn name(&self) -> &'static str {
        "vacatorrent"
    }

    fn post_links(&self, html: &str, post_url: &str) -> Result<Vec<ResolverLink>, String> {
        post_links_with(html, post_url, &VacaParseOptions::default())
    }

    fn release_title(&self, post: &SitePost, link: &ResolverLink, index: Option<usize>) -> String {
        release_title(&VACA_TITLE, post, link, index)
    }

    fn search_page_html(&self, self_url: &str, items: &[SearchItem]) -> String {
        search_page_html(
            self_url,
            items,
            &|post, link, index| self.release_title(post, link, index),
            &|post| match post.poster.as_deref().filter(|p| !p.is_empty()) {
                Some(poster) => format!(
                    r#"<div class="poster"><img src="{}"></div>"#,
                    escape_html(poster)
                ),
                None => String::new(),
            },
            &|post| Some(post.title.clone()),
        )
    }
}
