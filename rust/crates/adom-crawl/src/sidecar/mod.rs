//! Sidecar do raspador Rust do Adom.
//!
//! Este módulo contém o cliente HTTP que comunica com o Node
//! (postagem de resultados e consulta de atividade), o freio
//! de tráfego que pausa o crawl quando o usuário está ativo,
//! e o servidor HTTP que o sidecar expõe para o painel.

pub mod activity;
/// Rotas administrativas do crawl (`/crawl/*`): requeue, reprocessar sem obra
/// e cursor. Catraca de 400 linhas fora do `server.rs`.
pub mod admin;
pub mod http_client;
pub mod server;
/// Composição de produção das costuras (ingestão nativa do T3-L3).
pub mod wiring;

#[cfg(test)]
mod admin_tests;

pub use activity::recent_user_traffic;
pub use http_client::{SidecarHttpClient, SidecarHttpError};
pub use server::{run as run_server, AppState};
pub use wiring::production_ingest;
