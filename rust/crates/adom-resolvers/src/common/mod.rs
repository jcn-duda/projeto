//! Fachada do núcleo BR. A implementação mora em `adom_crawl::br_core` (crate de
//! baixo, que o raspador também consome) — ver o doc de lá. Reexportar em vez de
//! mover os `use` dos 30 arquivos de `sites`/`flows` mantém `crate::common::…`
//! valendo e o golden do resolver como teste de regressão da mudança.

pub use adom_crawl::br_core::collector;
pub use adom_crawl::br_core::episode;
pub use adom_crawl::br_core::magnet;
pub use adom_crawl::br_core::page;
pub use adom_crawl::br_core::release;
pub use adom_crawl::br_core::rules;
pub use adom_crawl::br_core::text;

pub use adom_crawl::br_core::{
    clean_post_title, encode_uri_component, episode_tag, parse_download_links, release_title,
    rss_xml, search_page_html, CollectorHooks, ReleaseTitleConfig, Resolved, RssConfig, SearchItem,
    SitePost, Step, UNKNOWN_SIZE,
};
