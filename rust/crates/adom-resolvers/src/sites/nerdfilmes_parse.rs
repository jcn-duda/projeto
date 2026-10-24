//! Parsers do NerdFilmes (`nerdfilmes-parsers.ts`): posts da busca WordPress
//! (`parsePosts`), data do post (`parsePostDate`) e as guardas de magnet direto
//! (`isValidDirectMagnet`) e de `/link.php` da mesma origem.

use std::sync::LazyLock;

use adom_crawl::resolver_matching::is_generic_list_post;
use regex::Regex;
use url::Url;

use super::text::{attr_content, attr_href, attr_title, strip_tags_rich};
use crate::common::rules::compile;
use crate::common::SitePost;

// ─── posts da busca ──────────────────────────────────────────────────────

/// `article.col` (a primeira classe `col` exata do bloco).
static ARTICLE: LazyLock<Regex> = LazyLock::new(|| {
    compile(r#"(?i)<article{B}[^>]*class=["'][^"']*{B}col{B}[^"']*["'][^>]*>([\s\S]*?)</article>"#)
});
/// `div.image`: o PRIMEIRO dentro do bloco, como o `match` sem `g` do TS.
static IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    compile(r#"(?i)<div{B}[^>]*class=["'][^"']*{B}image{B}[^"']*["'][^>]*>([\s\S]*?)</div>"#)
});
static ANCHOR_OPEN: LazyLock<Regex> = LazyLock::new(|| compile(r"(?i)<a{B}[^>]*>"));

/// `parsePosts(html)` do TS. O `base_url` não entra: o TS usa o `href` cru (o
/// que vier no HTML), sem resolver contra a origem. Sem `poster`/`date`.
pub fn parse_search_posts(html: &str, _base_url: &str) -> Vec<SitePost> {
    let mut posts: Vec<SitePost> = Vec::new();
    for article in ARTICLE.captures_iter(html) {
        let Some(image) = IMAGE.captures(&article[1]) else {
            continue;
        };
        let Some(anchor) = ANCHOR_OPEN.find(&image[1]) else {
            continue;
        };
        let tag = anchor.as_str();
        let url = attr_href(tag).filter(|u| !u.is_empty());
        let clean = attr_title(tag)
            .filter(|t| !t.is_empty())
            .map(|t| strip_tags_rich(&t))
            .filter(|t| !t.is_empty());
        let (Some(url), Some(clean)) = (url, clean) else {
            continue;
        };
        if is_generic_list_post(&clean) || posts.iter().any(|p| p.url == url) {
            continue;
        }
        posts.push(SitePost {
            title: clean,
            url,
            ..Default::default()
        });
    }
    posts
}

// ─── data do post ────────────────────────────────────────────────────────

static META_DATE: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?i)<meta{B}[^>]*(?:property|name)=["'](?:article:published_time|datePublished)["'][^>]*>"#,
    )
});
static JSON_DATE: LazyLock<Regex> =
    LazyLock::new(|| compile(r#"(?i)["']datePublished["']\s*:\s*["']([^"']+)["']"#));

/// Forma ISO 8601 que o WordPress publica (e a data só com dia). O JS também
/// aceita RFC 2822 e outros; aqui eles viram `None` (ver o relatório).
static ISO_DATE: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r"^([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$",
    )
});

/// `parsePostDate`: `content` da meta, senão o JSON-LD, e o resultado em ISO
/// com milissegundos (`toISOString`). `None` = `Invalid Date` no TS.
pub fn parse_post_date(html: &str) -> Option<String> {
    let meta = META_DATE.find(html).and_then(|m| attr_content(m.as_str()));
    let json = JSON_DATE.captures(html).map(|c| c[1].to_string());
    let chosen = match meta {
        Some(content) if !content.is_empty() => content,
        _ => json.unwrap_or_default(),
    };
    iso_from_js_date(&chosen)
}

/// Dias desde 1970-01-01 (algoritmo civil; aceita dia fora do mês como o JS).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverso de `days_from_civil`: (ano, mês, dia).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// `Date.prototype.toISOString` a partir do instante em ms.
fn to_iso(ms: i64) -> String {
    const DAY: i64 = 86_400_000;
    let (y, m, d) = civil_from_days(ms.div_euclid(DAY));
    let rem = ms.rem_euclid(DAY);
    let (h, mi, s, f) = (
        rem / 3_600_000,
        rem % 3_600_000 / 60_000,
        rem % 60_000 / 1000,
        rem % 1000,
    );
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{f:03}Z")
}

/// Lê o subconjunto ISO. Sem fuso, o JS usa a hora local; aqui assume-se UTC
/// (o container roda em UTC).
fn iso_from_js_date(text: &str) -> Option<String> {
    let caps = ISO_DATE.captures(text)?;
    let num = |i: usize, default: i64| -> i64 {
        caps.get(i)
            .map_or(default, |m| m.as_str().parse().unwrap_or(default))
    };
    let (y, mo, d) = (num(1, 1970), num(2, 1), num(3, 1));
    let (h, mi, s) = (num(4, 0), num(5, 0), num(6, 0));
    let ms_frac = caps.get(7).map_or(0, |m| {
        let digits: String = m.as_str().chars().take(3).collect();
        format!("{digits:0<3}").parse::<i64>().unwrap_or(0)
    });
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 24 || mi > 59 || s > 59 {
        return None;
    }
    let offset = match caps.get(8).map(|m| m.as_str()) {
        None | Some("Z") => 0,
        Some(off) => {
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let hh: i64 = off[1..3].parse().ok()?;
            let mm: i64 = off[4..6].parse().ok()?;
            sign * (hh * 60 + mm) * 60_000
        }
    };
    let ms =
        days_from_civil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + s * 1000 + ms_frac
            - offset;
    Some(to_iso(ms))
}

// ─── guardas de link ─────────────────────────────────────────────────────

static MAGNET_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^magnet:").expect("magnet"));
static BTIH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^urn:btih:([^\n\r\u{2028}\u{2029}]+)$").expect("btih"));
static HASH_HEX40: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{40}$").expect("hex40"));
static HASH_B32: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[A-Z2-7]{32}$").expect("base32"));

/// `isValidDirectMagnet`: algum `xt` (nome sem caixa) com `urn:btih:` seguido de
/// hash hex de 40 ou base32 de 32, em qualquer posição dos parâmetros.
pub fn is_valid_direct_magnet(value: &str) -> bool {
    if !MAGNET_SCHEME.is_match(value) {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "magnet" {
        return false;
    }
    url.query_pairs().any(|(name, xt)| {
        name.eq_ignore_ascii_case("xt")
            && BTIH
                .captures(&xt)
                .map(|c| c[1].to_string())
                .is_some_and(|hash| HASH_HEX40.is_match(&hash) || HASH_B32.is_match(&hash))
    })
}

/// `isNerdSameOriginLinkPhp`: `/link.php` (sem caixa) da mesma origem do post.
pub fn is_nerd_same_origin_link_php(url: &Url, base: &str) -> bool {
    let Ok(base) = Url::parse(base) else {
        return false;
    };
    url.origin() == base.origin() && url.path().to_lowercase() == "/link.php"
}
