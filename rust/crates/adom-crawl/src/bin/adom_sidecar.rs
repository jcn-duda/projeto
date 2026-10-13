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
//! - `JACKETT_TEST_TOKEN` — token de autenticação para endpoints internos
//!   (fallback: `ADMIN_TOKEN`)
//! - `CRAWL_SIDECAR_PORT` — porta do servidor HTTP (default: 7077)
//! - `CRAWL_IDLE_WINDOW_MS` — janela de inatividade para freio (default: 60000)
//! - `CRAWL_MAX_CONCURRENT` — tarefas simultâneas (default: 4)
//! - `CRAWL_DELAY_MS` — atraso entre ciclos em ms (default: 1000)

use std::env;
use std::process;
use std::sync::Arc;

use adom_crawl::motor::types::MotorConfig;
use adom_crawl::motor::CrawlMotor;
use adom_crawl::sidecar::server::AppState;
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
    let sidecar_port = env_u64("CRAWL_SIDECAR_PORT", 7077) as u16;

    // Token unificado: JACKETT_TEST_TOKEN é o principal, ADMIN_TOKEN é alias.
    let auth_token = resolve_auth_token();

    if auth_token.is_empty() {
        eprintln!(
            "[adom-sidecar] JACKETT_TEST_TOKEN vazio; o sidecar precisa \
             de um token para autenticação."
        );
        process::exit(1);
    }

    let idle_window_ms = env_u64("CRAWL_IDLE_WINDOW_MS", 60_000);
    let max_concurrent = env_u64("CRAWL_MAX_CONCURRENT", 4);
    let delay_ms = env_u64("CRAWL_DELAY_MS", 1_000);

    eprintln!(
        "[adom-sidecar] iniciando — db={}, node={}, port={}, idle_window={}ms, \
         max_concurrent={}, delay={}ms",
        db_path, node_url, sidecar_port, idle_window_ms, max_concurrent, delay_ms
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
    let _http_client = SidecarHttpClient::new(node_url.clone(), auth_token.clone());

    // ── 5. Cria o motor de crawl (Agente 1) ─────────────────────────
    let config = MotorConfig {
        node_url: node_url.clone(),
        admin_token: auth_token.clone(),
        idle_window_ms,
        max_parallel: max_concurrent as usize,
        delay_ms,
        ..Default::default()
    };
    let motor = Arc::new(CrawlMotor::new(config));

    // ── 6. Inicia o servidor HTTP do sidecar ─────────────────────────
    // O servidor roda em background, em loopback, para o painel e entrypoint.
    let server_state = Arc::new(AppState {
        motor: motor.clone(),
        store: Arc::new(tokio::sync::Mutex::new(store)),
        auth_token,
    });
    let _server_handle = tokio::spawn(async move {
        adom_crawl::sidecar::server::run(sidecar_port, server_state).await;
    });

    // ── 7. Roda com graceful shutdown ────────────────────────────────
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

/// Resolve o token de autenticação unificado.
///
/// Prioridade: `JACKETT_TEST_TOKEN` → `ADMIN_TOKEN` (alias, com aviso).
/// Se nenhuma das duas estiver definida, retorna string vazia.
fn resolve_auth_token() -> String {
    let primary = env_or("JACKETT_TEST_TOKEN", "");
    if !primary.is_empty() {
        return primary;
    }
    let fallback = env_or("ADMIN_TOKEN", "");
    if !fallback.is_empty() {
        eprintln!(
            "[adom-sidecar] AVISO: JACKETT_TEST_TOKEN não definido, \
             usando ADMIN_TOKEN como alias."
        );
    }
    fallback
}
