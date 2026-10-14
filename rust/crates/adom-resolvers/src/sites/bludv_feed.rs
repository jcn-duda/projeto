//! Feed torznab do BLUDV: `createBludvRssXml` e `parsePostDate` de
//! `resolvers/profiles/bludv-parsers.ts`. O corpo do feed é o `rss_xml` do
//! núcleo (`br_core::page`); o site só escolhe o título do canal, a descrição
//! e o comentário de seeders — exatamente as opções que o TS passa.
//!
//! Sobre o `pubDate`: o TS usa `new Date(Date.UTC(ano, mes - 1, dia))` quando o
//! post tem `dd/mm/aaaa` e `new Date().toUTCString()` quando não tem. O dia da
//! semana é sempre CALCULADO. Não pode existir aqui um fallback fixo de data
//! (a antiga string congelada do oráculo, devolvida para qualquer post): ela
//! fez o golden passar enquanto nenhuma fixture tinha `dd/mm/aaaa`, escondendo
//! um feed divergente do TS para qualquer post datado que não fosse domingo. O
//! oráculo congela o relógio, então o teste injeta a data por `feed_with_date`
//! (mesmo padrão de apache/hdr/tdf).

use std::sync::LazyLock;

use adom_crawl::profile_parsers::ResolverLink;
use regex::Regex;

use crate::common::http_date::{date_utc_ms, http_date};
use crate::common::{release_title, rss_xml, RssConfig, SearchItem, SitePost};

/// `seedersComment` do TS, literal.
const SEEDERS_COMMENT: &str =
    "<!-- O BLUDV não publica seeds; 1 neutro pra não ser descartado por filtros. -->";

/// `(\d{2})\/(\d{2})\/(\d{4})` do TS: `\d` restrito a `[0-9]` pela regra de
/// paridade com o JS.
static RE_POST_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([0-9]{2})/([0-9]{2})/([0-9]{4})").expect("data do post"));

/// `Number(m[i])` do TS sobre o grupo capturado (o regex garante dígitos).
fn num(caps: &regex::Captures<'_>, group: usize) -> i64 {
    caps.get(group)
        .map_or(0, |m| m.as_str().parse().unwrap_or(0))
}

/// `parsePostDate` do TS: `dd/mm/aaaa` vira HTTP date com o dia da semana real;
/// sem data, usa `now_date` (o relógio corrente no `rss_xml` do trait, a data
/// congelada do oráculo no golden).
pub fn parse_post_date(date: Option<&str>, now_date: &str) -> String {
    let Some(caps) = RE_POST_DATE.captures(date.unwrap_or("")) else {
        return now_date.to_string();
    };
    // `Date.UTC(ano, mes - 1, dia)`: mês e dia estourados rolam como no JS.
    http_date(date_utc_ms(num(&caps, 3), num(&caps, 2) - 1, num(&caps, 1)))
}

/// Feed torznab com o "agora" injetado para os posts sem data.
pub fn feed_with_date(
    self_url: &str,
    items: &[SearchItem],
    category: u32,
    now_date: &str,
) -> String {
    let cfg = RssConfig {
        self_url,
        channel_title: "BLUDV (resolver)",
        title_of: &|post: &SitePost, link: &ResolverLink| {
            release_title(&super::TITLE, post, link, None)
        },
        pub_date_of: &|post: &SitePost| parse_post_date(post.date.as_deref(), now_date),
        with_description: true,
        seeders_comment: Some(SEEDERS_COMMENT),
        with_enclosure: false,
        compact: false,
    };
    rss_xml(&cfg, items, category)
}

#[cfg(test)]
mod tests {
    use super::parse_post_date;
    use crate::common::http_date::http_date_now;

    /// Valores do Node: `new Date(Date.UTC(2016, 3, 5)).toUTCString()`.
    #[test]
    fn data_do_post_tem_o_dia_da_semana_calculado() {
        assert_eq!(
            parse_post_date(Some("05/04/2016"), "IGNORED"),
            "Tue, 05 Apr 2016 00:00:00 GMT"
        );
        assert_eq!(
            parse_post_date(Some("13/10/2026"), "IGNORED"),
            "Tue, 13 Oct 2026 00:00:00 GMT"
        );
        assert_eq!(
            parse_post_date(Some("29/02/2024"), "IGNORED"),
            "Thu, 29 Feb 2024 00:00:00 GMT"
        );
        assert_eq!(
            parse_post_date(Some("31/12/2024"), "IGNORED"),
            "Tue, 31 Dec 2024 00:00:00 GMT"
        );
        // 01/01/2023 É domingo: o antigo código fixava "Sun" e acertava por acaso.
        assert_eq!(
            parse_post_date(Some("01/01/2023"), "IGNORED"),
            "Sun, 01 Jan 2023 00:00:00 GMT"
        );
        assert_eq!(
            parse_post_date(Some("14/08/2022"), "IGNORED"),
            "Sun, 14 Aug 2022 00:00:00 GMT"
        );
        assert_eq!(
            parse_post_date(Some("02/03/2024"), "IGNORED"),
            "Sat, 02 Mar 2024 00:00:00 GMT"
        );
    }

    #[test]
    fn sem_data_usa_o_relogio_injetado() {
        for absent in [None, Some(""), Some("sem data"), Some("1/1/2024")] {
            assert_eq!(parse_post_date(absent, "TERA_INJETADA"), "TERA_INJETADA");
        }
        // O relógio real também sai no formato HTTP (dia da semana calculado).
        assert!(
            http_date_now().ends_with("GMT"),
            "relógio: {}",
            http_date_now()
        );
    }

    #[test]
    fn mes_e_dia_estourados_rolam_como_no_js() {
        // `Date.UTC(1900, -1, 0)` = qui, 30 nov 1899 (o JS não rejeita).
        assert_eq!(
            parse_post_date(Some("00/00/1900"), "IGNORED"),
            "Thu, 30 Nov 1899 00:00:00 GMT"
        );
    }
}
