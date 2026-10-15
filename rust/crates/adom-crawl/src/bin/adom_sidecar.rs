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
use std::sync::{Arc, Mutex as StdMutex};

use adom_crawl::gate::{
    FlareProbe, GateExecutor, GateExecutorConfig, GateResolver, HttpGateResolver,
};
use adom_crawl::motor::types::MotorConfig;
use adom_crawl::motor::CrawlMotor;
use adom_crawl::page_engine::CrawlPageEngine;
use adom_crawl::protector_follow::ProtectorFollow;
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
    // Teto de pagamentos de portão por hora (custo ~30s de FlareSolverr cada;
    // 0 desliga o executor de fundo).
    let gate_hourly = env_u64("CRAWL_GATE_HOURLY", 4) as u32;

    eprintln!(
        "[adom-sidecar] iniciando — db={}, node={}, port={}, idle_window={}ms, \
         max_concurrent={}, delay={}ms, gate_hourly={}",
        db_path, node_url, sidecar_port, idle_window_ms, max_concurrent, delay_ms, gate_hourly
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
        gate_hourly,
        ..Default::default()
    };
    // Conecta o PageEngine real (C5): fetch + parser. Sem isto o motor usa
    // UnwiredPageEngine (is_ready=false) e nenhuma URL é processada.
    // Botões de protetor (Nerd, Comando, TDF) seguidos pelo resolver local, como
    // o motor TS faz; `CRAWL_FOLLOW_PROTECTOR=false` desliga.
    let protector =
        (env_or("CRAWL_FOLLOW_PROTECTOR", "true") != "false").then(|| ProtectorFollow {
            host: env_or("BR_RESOLVERS_HOST", "127.0.0.1"),
            port_offset: env_u64("BR_RESOLVERS_PORT_OFFSET", 0) as u16,
            timeout_ms: env_u64("CRAWL_PROTECTOR_TIMEOUT_MS", 45_000),
            ..ProtectorFollow::default()
        });
    let mut page_engine = CrawlPageEngine::default();
    page_engine.protector = protector;
    // Arc compartilhado: o motor o usa como `PageEngine` e o executor de
    // portões como `FlareProbe` (mesma faixa única do solver).
    let engine: Arc<CrawlPageEngine> = Arc::new(page_engine);
    let motor = Arc::new(CrawlMotor::new(config.clone()).with_page_engine(engine.clone()));

    // ── 6. Inicia o servidor HTTP do sidecar ─────────────────────────
    // O servidor roda em background, em loopback, para o painel e entrypoint.
    let server_state = Arc::new(AppState {
        motor: motor.clone(),
        store: Arc::new(tokio::sync::Mutex::new(store)),
        // Clone: o executor de portões (6b) também precisa do token.
        auth_token: auth_token.clone(),
    });
    let _server_handle = tokio::spawn(async move {
        adom_crawl::sidecar::server::run(sidecar_port, server_state).await;
    });

    // ── 6b. Executor de fundo dos pendentes de portão (BLUDV) ───────────
    // Paga os posts `gate-pending` FORA do passo de raspagem, só com o app
    // ocioso e até o teto por hora. `CRAWL_GATE_HOURLY=0` desliga.
    if gate_hourly > 0 {
        let offset = env_u64("BR_RESOLVERS_PORT_OFFSET", 0) as u16;
        let mut gate_cfg = GateExecutorConfig::from_motor(&config);
        gate_cfg.resolver_host = env_or("BR_RESOLVERS_HOST", "127.0.0.1");
        gate_cfg.resolver_port = 8700u16.saturating_add(offset); // bludv
                                                                 // Segunda conexão WAL no mesmo crawl.db: o motor tem a sua e o
                                                                 // executor não briga por lock na régua `spawn_blocking` de cada um.
        let gate_store = match CrawlStore::open(&db_path) {
            Ok(s) => Arc::new(StdMutex::new(s)),
            Err(e) => {
                eprintln!("[adom-sidecar] erro ao abrir banco do executor: {}", e);
                process::exit(1);
            }
        };
        let resolver: Arc<dyn GateResolver> = Arc::new(HttpGateResolver::new(
            &gate_cfg.resolver_host,
            gate_cfg.resolver_port,
            gate_cfg.resolver_timeout_ms,
        ));
        let flare: Arc<dyn FlareProbe> = engine.clone();
        let executor = Arc::new(GateExecutor::new(
            gate_cfg,
            config,
            gate_store,
            Arc::new(SidecarHttpClient::new(node_url, auth_token)),
            resolver,
            flare,
        ));
        tokio::spawn(executor.run());
    } else {
        eprintln!("[adom-sidecar] executor de portão desligado (CRAWL_GATE_HOURLY=0)");
    }

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
