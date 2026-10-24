//! Núcleo BR compartilhado: o que no TS vive em `resolvers/release-format.ts`,
//! `resolvers/link-collector.ts`, `resolvers/text.ts` e `resolvers/magnet-extract.ts`.
//!
//! Mora em `adom-crawl` — e não em `adom-resolvers` — porque os dois consumidores
//! lêem o MESMO TypeScript: o resolver (`*-resolver/server.ts` → Jackett) e o
//! raspador (`src/providers/crawl-*`). A dependência só existe num sentido
//! (`adom-resolvers` → `adom-crawl`), então o núcleo tem que descer para o crate
//! de baixo; senão cada um porta sua cópia e elas divergem em silêncio.
//! `adom-resolvers/src/common` é só a reexportação deste módulo.
//!
//! Cada site (`adom_resolvers::sites`, e os adaptadores do raspador) liga seus
//! ganchos aqui; a saída (HTML do Cardigann, feed torznab) tem que sair byte a
//! byte igual à do TS, porque é o que as definições do Jackett leem.

pub mod apache;
pub mod collector;
pub mod episode;
pub mod hdr;
pub mod http_date;
pub mod magnet;
pub mod page;
pub mod release;
pub mod rules;
pub mod text;
pub mod vaca;

pub use collector::{parse_download_links, CollectorHooks, Resolved, Step};
pub use http_date::{date_utc_ms, days_from_civil, http_date, http_date_now, http_date_secs};
pub use page::{
    encode_uri_component, rss_xml, search_page_html, RssConfig, SearchItem, SitePost, UNKNOWN_SIZE,
};
pub use release::{clean_post_title, episode_tag, release_title, ReleaseTitleConfig};
