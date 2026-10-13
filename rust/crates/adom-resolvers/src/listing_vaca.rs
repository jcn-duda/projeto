//! Parser de listagem do VacaTorrent: a busca é AJAX e devolve JSON, não HTML.
//! Separado de `listing_parsers` para a fonte ficar abaixo da catraca de 400 linhas.

use std::collections::HashSet;

use adom_crawl::resolver_matching::is_generic_list_post;
use adom_crawl::resolver_text::strip_tags;

use super::{resolve_url, ListingPost};

pub(super) fn parse_vaca_posts(text: &str, base_url: &str) -> Vec<ListingPost> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let cleaned = text.trim();
    let json_text = if cleaned.starts_with('<') {
        strip_tags(cleaned)
    } else {
        cleaned.to_string()
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_text) else {
        return out;
    };
    let arr = match &parsed {
        serde_json::Value::Array(a) => a.clone(),
        serde_json::Value::Object(o) => o
            .get("results")
            .or_else(|| o.get("posts"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => return out,
    };
    for item in arr {
        let title = item
            .get("title")
            .and_then(|v| v.as_str())
            .map(strip_tags)
            .unwrap_or_default();
        let link = item
            .get("link")
            .or_else(|| item.get("url"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if title.is_empty() || link.is_empty() {
            continue;
        }
        let Some(url) = resolve_url(link, base_url) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        if is_generic_list_post(&title) {
            continue;
        }
        let poster = item
            .get("thumbnail")
            .and_then(|v| v.as_str())
            .map(adom_core::decode_entities);
        out.push(ListingPost { title, url, poster });
    }
    out
}
