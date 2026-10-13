//! Sidecar do raspador Rust do Adom.
//!
//! Roda o loop de crawl como processo independente, comunicando-se
//! com o Node via HTTP (POST resultados, GET atividade).
//!
//! # Variáveis de ambiente
//!
//! - `CRAWL_ENGINE=rust` — obrigatório; sem ele o sidecar recusa iniciar
//! - `CRAWL_DB_PATH` — caminho do banco SQLite (default: `./data/crawl.db`)
//! - `CRAWL_NODE_URL` — URL do Node (default: `http://127.0.0.1:7000`)
//! - `ADMIN_TOKEN` — token de autenticação para endpoints internos
//! - `CRAWL_IDLE_WINDOW_MS` — janela de inatividade para freio (default: 60000)
//! - `CRAWL_MAX_CONCURRENT` — tarefas simultâneas (default: 4)
//! - `CRAWL_DELAY_MS` — atraso entre ciclos em ms (default: 1000)

use std::env;
use std::process;

use adom_crawl::motor::types::MotorConfig;
use adom_crawl::motor::CrawlMotor;
use adom_crawl::sidecar::SidecarHttpClient;
use adom_crawl::store::CrawlStore;

/// Lê uma variável de ambiente com valor padrão.
fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

/// Lê uma variável de ambiente e faz parse para `u64`.
fn env_u64(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[tokio::main]
async fn main() {
    // ── 1. Verifica CRAWL_ENGINE=rust ────────────────────────────────
    let engine = env_or("CRAWL_ENGINE", "");
    if engine != "rust" {
        eprintln!(
            "[adom-sidecar] CRAWL_ENGINE não está definido como 'rust' (valor: {:?}). \
             O sidecar só roda com o motor Rust.",
            engine
        );
        process::exit(1);
    }

    // ── 2. Lê configuração do ambiente ───────────────────────────────
    let db_path = env_or("CRAWL_DB_PATH", "./data/crawl.db");
    let node_url = env_or("CRAWL_NODE_URL", "http://127.0.0.1:7000");
    let admin_token = env_or("ADMIN_TOKEN", "");
    let idle_window_ms = env_u64("CRAWL_IDLE_WINDOW_MS", 60_000);
    let max_concurrent = env_u64("CRAWL_MAX_CONCURRENT", 4);
    let delay_ms = env_u64("CRAWL_DELAY_MS", 1_000);

    if admin_token.is_empty() {
        eprintln!("[adom-sidecar] ADMIN_TOKEN vazio; o sidecar precisa de um token para autenticação.");
        process::exit(1);
    }

    eprintln!(
        "[adom-sidecar] iniciando — db={}, node={}, idle_window={}ms, max_concurrent={}, delay={}ms",
        db_path, node_url, idle_window_ms, max_concurrent, delay_ms
    );

    // ── 3. Abre o CrawlStore (Agente 2) ──────────────────────────────
    let store = match CrawlStore::open(&db_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[adom-sidecar] erro ao abrir banco em {}: {}", db_path, e);
            process::exit(1);
        }
    };

    if let Err(e) = store.migrate() {
        eprintln!("[adom-sidecar] erro ao migrar banco: {}", e);
        process::exit(1);
    }

    // ── 4. Cria o cliente HTTP ───────────────────────────────────────
    // O cliente será integrado ao motor quando o Agente 1 conectar a camada HTTP.
    let _http_client = SidecarHttpClient::new(node_url.clone(), admin_token);

    // ── 5. Cria o motor de crawl (Agente 1) ─────────────────────────
    let config = MotorConfig {
        node_url: node_url.clone(),
        admin_token: admin_token.clone(),
        idle_window_ms,
        max_parallel: max_concurrent as usize,
        delay_ms,
        ..Default::default()
    };
    let motor = CrawlMotor::new(config);

    // ── 6. Roda com graceful shutdown ────────────────────────────────
    tokio::select! {
        result = motor.run() => {
            match result {
                Ok(()) => eprintln!("[adom-sidecar] motor encerrou normalmente."),
                Err(e) => {
                    eprintln!("[adom-sidecar] motor encerrou com erro: {}", e);
                    process::exit(1);
                }
            }
        }
        _ = tokio::signal::ctrl_c() => {
            eprintln!("[adom-sidecar] ctrl+c recebido; encerrando graciosamente...");
            motor.stop().await;
        }
    }

    eprintln!("[adom-sidecar] até logo.");
}
