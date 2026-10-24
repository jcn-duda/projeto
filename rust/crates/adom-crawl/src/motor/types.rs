//! Types compartilhados do motor do raspador (C4).
//!
//! Espelham os types do TypeScript (crawl-types.ts) para manter compatibilidade
//! entre o sidecar Rust e o Node.js.

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};

use crate::store::ops::{MarkResult, UrlRow};

/// Status de uma URL trabalhada (espelha CrawlResultStatus do TS).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CrawlResultStatus {
    Done,
    NoTorrent,
    NoWork,
    Error,
    Simulated,
    Partial,
}

/// Resultado de UMA página trabalhada (espelha CrawlWorkResult do TS crawl-types.ts:243-295).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrawlWorkResult {
    pub url: String,
    pub url_key: String,
    pub site: String,
    pub status: CrawlResultStatus,
    pub imdb: Option<String>,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub kind: String, // "movie" | "series"
    pub releases: Vec<CrawlRawItem>,
    pub groups: Vec<CrawlReleaseGroup>,
    pub unlocated: Vec<CrawlRawItem>,
    pub progress: Option<String>, // JSON SeriesWorkProgress
    pub request_cost: u32,
    pub error: String,
}

impl CrawlWorkResult {
    /// Resultado placeholder: o parser ainda não está integrado ao loop.
    ///
    /// Existe para o modo degradado de diagnóstico (`MotorConfig::degraded_write`):
    /// o Node recebe a linha, loga `status=error (sem gravação)` e o painel vê o
    /// motivo real do motor parado. O `request_cost` é 0 porque nenhuma requisição
    /// ao site foi feita — cobrar custo de página falsa enganaria o teto por hora.
    pub fn parser_pending(row: &UrlRow) -> Self {
        Self {
            url: row.url.clone(),
            url_key: row.url_key.clone(),
            site: row.site.clone(),
            status: CrawlResultStatus::Error,
            imdb: row.imdb.clone(),
            title: None,
            year: None,
            kind: row.kind.clone(),
            releases: Vec::new(),
            groups: Vec::new(),
            unlocated: Vec::new(),
            progress: None,
            request_cost: 0,
            error: "parser integration pending".to_string(),
        }
    }
}

/// Item cru de release (espelha RawItem do TS).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrawlRawItem {
    pub title: String,
    pub magnet: Option<String>,
    pub link: Option<String>,
    pub size: Option<String>,
    pub seeders: Option<u32>,
    pub tracker: Option<String>,
    pub is_br: bool,
}

/// Grupo de releases (séries: S/E, S, raiz).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrawlReleaseGroup {
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub releases: Vec<CrawlRawItem>,
}

/// Config do motor (lida do .env / config).
#[derive(Debug, Clone)]
pub struct MotorConfig {
    pub max_parallel: usize,         // default 3
    pub delay_ms: u64,               // default 1000
    pub max_per_hour: u32,           // default 1500
    pub max_tries: u32,              // default 3
    pub error_pause_streak: u32,     // default 5
    pub idle_window_ms: u64,         // default 600_000 (10 min)
    pub step_deadline_ms: u64,       // default 700_000
    pub flare_step_deadline_ms: u64, // default 2_660_000
    pub node_url: String,            // "http://127.0.0.1:<porta>"
    pub admin_token: String,         // token no header
    /// Caminho do `crawl.db`. Espelha `CRAWL_DB_PATH` do TS (`config/crawl.ts`).
    pub db_path: String,
    /// Base do backoff de erro transitório (1ª falha), em ms.
    /// Porta do `DEFAULT_RETRY_BASE_MS` do TS (`crawl-store-rules.ts`).
    pub retry_base_ms: u64,
    /// Teto do backoff exponencial — erro persistente não dorme mais que isto.
    /// Porta do `ERROR_BACKOFF_CAP_MS` do TS.
    pub error_backoff_cap_ms: u64,
    /// Duração da janela do teto de requisições por hora.
    pub hour_window_ms: u64,
    /// Escreve placeholder no store mesmo sem parser integrado.
    ///
    /// Default `false`: ligar isto com um `crawl.db` real queima as URLs em
    /// `error` (o `mark_result` incrementa `tries` a cada escrita). É fuga para
    /// banco de teste e para ver o loop andando de ponta a ponta.
    pub degraded_write: bool,
}

impl Default for MotorConfig {
    fn default() -> Self {
        Self {
            max_parallel: 3,
            delay_ms: 1000,
            max_per_hour: 1500,
            max_tries: 3,
            error_pause_streak: 5,
            idle_window_ms: 600_000,
            step_deadline_ms: 700_000,
            flare_step_deadline_ms: 2_660_000,
            node_url: "http://127.0.0.1:3000".to_string(),
            admin_token: String::new(),
            db_path: "./data/crawl.db".to_string(),
            retry_base_ms: 60_000,
            error_backoff_cap_ms: 6 * 3_600_000,
            hour_window_ms: 3_600_000,
            degraded_write: false,
        }
    }
}

// ─── Costura do parser (C5 pluga aqui) ───────────────────────────────────────

/// Futuro boxed de UMA página. Sem `async_trait`: nenhuma dependência nova.
pub type PageFuture<'a> = Pin<Box<dyn Future<Output = PageOutcome> + Send + 'a>>;

/// O que a tentativa de uma página produziu.
///
/// `Work` vai boxed: `CrawlWorkResult` é grande (listas de releases) e as outras
/// variantes são minúsculas; sem o box cada `PageOutcome` carregaria o tamanho
/// do maior caso só para dizer "deu erro".
#[derive(Debug, Clone)]
pub enum PageOutcome {
    /// Página lida e parseada; o resultado segue para o Node e para o store.
    Work(Box<CrawlWorkResult>),
    /// Rede/parse falhou — a URL volta para a fila com backoff.
    Failed(String),
    /// O prazo duro do passo (`step_deadline_ms`) venceu: geração invalidada.
    TimedOut,
}

/// Quem transforma uma `UrlRow` em resultado de página.
///
/// É o ÚNICO ponto do loop que depende do parser + fetch de rede. O `C4` entrega
/// o loop ligando store, HTTP e store-back; o `C5` implementa esta trait com
/// `net::fetch_text_direct` + `page_parser::parse_crawl_page` e injeta em
/// [`super::r#loop::CrawlMotor::with_page_engine`].
pub trait PageEngine: Send + Sync {
    /// O parser está ligado? `false` faz o tick NÃO reivindicar URLs: um
    /// `mark_result` sem parser queima `tries` e dorme URLs boas por 24 h.
    fn is_ready(&self) -> bool;

    /// Trabalha UMA página. O prazo duro é aplicado pelo loop, não por aqui.
    fn execute<'a>(&'a self, row: &'a UrlRow) -> PageFuture<'a>;
}

/// Engine padrão do C4: fetch+parse ainda não integrados.
pub struct UnwiredPageEngine;

impl PageEngine for UnwiredPageEngine {
    fn is_ready(&self) -> bool {
        false
    }

    fn execute<'a>(&'a self, row: &'a UrlRow) -> PageFuture<'a> {
        let work = CrawlWorkResult::parser_pending(row);
        Box::pin(async move { PageOutcome::Work(Box::new(work)) })
    }
}

// ─── Regras puras de decisão do tick ─────────────────────────────────────────
// Vivem aqui (e não em `loop.rs`) porque são a mesma classe de regra que
// `crawl-store-rules.ts` no TS: pura, testável sem runtime async e sem rede.

/// Epoch ms atual (as colunas de tempo do store são `i64`).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Backoff exponencial `base * 2^(tries-1)` com teto — porta do
/// `errorBackoffMs` de `crawl-store-rules.ts` (piso de 1 s: base minúscula é
/// martelada de requisição).
pub fn error_backoff_ms(base_ms: u64, cap_ms: u64, tries: u32) -> u64 {
    let base = base_ms.max(1_000);
    base.saturating_mul(1u64 << tries.saturating_sub(1).min(20))
        .min(cap_ms)
}

/// Rótulo persistido — tem que bater com os status que `counters()` entende.
fn status_label(status: &CrawlResultStatus) -> &'static str {
    use CrawlResultStatus as S;
    match status {
        S::Done => "done",
        S::NoTorrent => "no-torrent",
        S::NoWork => "no-work",
        S::Error => "error",
        S::Simulated => "simulated",
        S::Partial => "partial",
    }
}

/// Releases indexáveis da página: planas + agrupadas por temporada/episódio.
fn counted_releases(work: &CrawlWorkResult) -> u32 {
    (work.releases.len() + work.groups.iter().map(|g| g.releases.len()).sum::<usize>()) as u32
}

/// Resultado de erro para uma linha (forma do placeholder, mensagem própria).
///
/// Cobra o PISO de uma requisição: `error_work` é construído quando a engine
/// falhou ou estourou o prazo — uma tentativa de fetch aconteceu, e o custo real
/// por página já não é conhecido. Sobrestimar em 1 é seguro para o teto por
/// hora; subestimar em 0 deixaria um site pendurado consumir requisições sem
/// nunca gastar orçamento.
pub fn error_work(row: &UrlRow, msg: &str) -> CrawlWorkResult {
    let mut work = CrawlWorkResult::parser_pending(row);
    work.error = msg.to_string();
    work.request_cost = work.request_cost.max(1);
    work
}

impl MarkResult {
    /// Traduz o resultado da página na escrita do `crawl_url`.
    ///
    /// Espelha `applyResult` de `crawl-store-rules.ts` com uma adaptação ao
    /// CONTRATO do store Rust: `mark_result` volta a linha para `pending` sempre
    /// que `next_at > 0`. Logo, o retry vive em `next_at` (a linha fica
    /// `pending`) e o esgotamento de `tries` é o único caso terminal `error` —
    /// recuperável pelo "Reprocessar erros" do painel (`requeue_errors`).
    pub fn from_work(
        row: &UrlRow,
        work: &CrawlWorkResult,
        delivered: bool,
        cfg: &MotorConfig,
        now: i64,
    ) -> Self {
        let base = Self {
            status: status_label(&work.status).to_string(),
            imdb: work.imdb.clone(),
            title: work.title.clone(),
            year: work.year,
            releases: counted_releases(work),
            error: String::new(),
            progress: work.progress.clone().unwrap_or_default(),
            next_at: 0,
            request_cost: work.request_cost,
        };
        // Sucesso entregue: terminal. `partial` é avanço, então acorda na base.
        if delivered && !matches!(work.status, CrawlResultStatus::Error) {
            let avancando = matches!(work.status, CrawlResultStatus::Partial);
            return Self {
                error: work.error.clone(),
                next_at: if avancando {
                    now + cfg.retry_base_ms as i64
                } else {
                    0
                },
                ..base
            };
        }
        // Falha de parse/rede/entrega: backoff crescente até esgotar tentativas.
        let tentativas = row.tries.saturating_add(1);
        let esgotado = tentativas >= cfg.max_tries.max(1);
        let mut error = work.error.clone();
        if !delivered && error.is_empty() {
            error = "entrega ao node falhou".to_string();
        }
        Self {
            status: "error".to_string(),
            releases: 0,
            progress: String::new(),
            error: if error.is_empty() {
                "erro".to_string()
            } else {
                error
            },
            next_at: if esgotado {
                0
            } else {
                now + error_backoff_ms(cfg.retry_base_ms, cfg.error_backoff_cap_ms, tentativas)
                    as i64
            },
            ..base
        }
    }
}

/// Snapshot do status do motor (para o painel).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MotorStatus {
    pub active: bool,
    pub sites: Vec<SiteStatus>,
    pub pages_this_hour: u32,
    pub global_paused: bool,
}

/// Status de um site individual.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteStatus {
    pub site_id: String,
    pub pending: u32,
    pub done: u32,
    pub no_torrent: u32,
    pub error: u32,
    pub inflight: u32,
    pub releases: u32,
}
