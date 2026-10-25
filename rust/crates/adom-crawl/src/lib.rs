//! Submódulos e parsers puros do raspador de sites BR do Adom.
//! Divididos por famílias de parser conforme fase C1 do plano de migração.

pub mod br_core;
pub mod flare;
pub mod gate;
pub mod http_session;
// Ingestão nativa da raspagem (T3-L3): banco vivo → índice → invalidação.
pub mod ingest;
pub mod listing;
pub mod mico;
pub mod mico_discovery;
pub mod mico_net;
pub mod mico_page;
pub mod motor;
pub mod nested_url;
pub mod net;
pub mod page_engine;
pub mod page_parser;
pub mod policy;
pub mod profile_parsers;
pub mod protector;
pub mod protector_follow;
pub mod resolver_cache;
pub mod resolver_concurrency;
pub mod resolver_matching;
pub mod resolver_site_selector;
pub mod resolver_text;
pub mod resolver_warm;
pub mod season_page;
pub mod shared;
pub mod sidecar;
pub mod site_profiles;
pub mod sitemap;
pub mod store;
pub mod vaca_series;
pub mod work_name;

pub use page_parser::*;
pub use policy::*;
pub use season_page::*;
pub use sitemap::*;
pub use vaca_series::*;
