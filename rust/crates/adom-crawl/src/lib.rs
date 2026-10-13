//! Submódulos e parsers puros do raspador de sites BR do Adom.
//! Divididos por famílias de parser conforme fase C1 do plano de migração.

pub mod shared;
pub mod work_name;
pub mod sitemap;
pub mod listing;
pub mod season_page;
pub mod vaca_series;
pub mod mico;
pub mod profile_parsers;

pub use sitemap::*;
pub use season_page::*;
pub use vaca_series::*;
