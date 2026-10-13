//! Políticas operacionais do motor de raspagem.

pub mod crawl_cycle;
pub mod crawl_dispatch;
pub mod crawl_pauses;
pub mod crawl_rate;
pub mod crawl_site_select;
pub mod crawl_status_view;
pub mod crawler_live;

pub use crawl_cycle::*;
pub use crawl_dispatch::*;
pub use crawl_pauses::*;
pub use crawl_rate::*;
pub use crawl_site_select::*;
pub use crawl_status_view::*;
pub use crawler_live::*;
