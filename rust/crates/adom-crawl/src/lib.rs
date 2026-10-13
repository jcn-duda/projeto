//! Submódulos e parsers puros do raspador de sites BR do Adom.
//! Divididos por famílias de parser conforme fase C1 do plano de migração.

pub mod listing;
pub mod mico;
pub mod mico_net;
pub mod net;
pub mod flare;
pub mod page_parser;
pub mod policy;
pub mod profile_parsers;
pub mod season_page;
pub mod shared;
pub mod site_profiles;
pub mod sitemap;
pub mod vaca_series;
pub mod motor;
pub mod sidecar;
pub mod store;
pub mod work_name;

pub use page_parser::*;
pub use policy::*;
pub use season_page::*;
pub use sitemap::*;
pub use vaca_series::*;
