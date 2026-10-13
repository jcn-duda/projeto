//! Núcleo comum dos 8 profiles: o que no TS vive em `resolvers/release-format.ts`
//! e `resolvers/link-collector.ts`. Cada site (`crate::sites`) liga seus ganchos
//! aqui; a saída (HTML do Cardigann, feed torznab) tem que sair byte a byte igual
//! à do TS, porque é o que as definições do Jackett leem.

pub mod collector;
pub mod episode;
pub mod page;
pub mod release;
pub mod rules;

pub use collector::{parse_download_links, CollectorHooks, Resolved, Step};
pub use page::{
    encode_uri_component, rss_xml, search_page_html, RssConfig, SearchItem, SitePost, UNKNOWN_SIZE,
};
pub use release::{clean_post_title, episode_tag, release_title, ReleaseTitleConfig};
