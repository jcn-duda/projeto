//! Sidecar do raspador Rust do Adom.
//!
//! Este módulo contém o cliente HTTP que comunica com o Node
//! (postagem de resultados e consulta de atividade) e o freio
//! de tráfego que pausa o crawl quando o usuário está ativo.

pub mod activity;
pub mod http_client;

pub use activity::recent_user_traffic;
pub use http_client::{SidecarHttpClient, SidecarHttpError};
