//! Types compartilhados do motor do raspador (C4).
//!
//! Espelham os types do TypeScript (crawl-types.ts) para manter compatibilidade
//! entre o sidecar Rust e o Node.js.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::site_clock::{SiteClock, SiteHold};
use crate::store::ops::UrlRow;

/// Status de uma URL trabalhada (espelha CrawlResultStatus do TS).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CrawlResultStatus {
    Done,
    NoTorrent,
    /// Pendência de portão (BLUDV): a página anuncia torrent SÓ atrás do
    /// portão de anúncio, cujo pagamento (~30s de FlareSolverr) nunca cabe no
    /// passo de raspagem. O motor grava a pendência no store e o executor de
    /// fundo paga FORA do passo; o Node não recebe resultado neste status.
    GatePending,
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
    /// Href do portão quando o status é `GatePending`. NÃO faz parte do
    /// contrato com o Node (que não recebe este status): fica no crate e vai
    /// para a `crawl_gate` do store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<String>,
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
            gate: None,
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
    /// Teto de PAGAMENTOS de portão por hora (o custo é ~30s de FlareSolverr
    /// por post, num solver que atende um pedido por vez e é o mesmo da busca
    /// ao vivo). Default baixo de propósito; porta de `CRAWL_GATE_HOURLY`.
    pub gate_hourly: u32,
    /// Intervalo entre rodadas COMPLETAS de descoberta do MESMO site. Rodada
    /// parcial volta no prazo curto de retry, não neste. Porta de
    /// `CRAWL_DISCOVERY_INTERVAL_MS` (no TS a descoberta era o ciclo inteiro).
    pub discovery_interval_ms: u64,
    /// Descoberta de SÉRIES ligada (porta de `CRAWL_SERIES_ENABLED`, default
    /// ON e só global). Desligada, nenhuma URL `tv_show` entra na fila e o
    /// cursor de série não anda.
    pub series_enabled: bool,
    /// Teto de páginas por RODADA da descoberta por LISTAGEM (HDR/Apache).
    /// Porta de `CRAWL_LISTING_MAX_PAGES_PER_ROUND`; 0 desliga o teto.
    pub listing_max_pages_per_round: u32,
    /// Relógio de espera POR SITE (Fase 0 do 429). Vive na config porque o
    /// `BatchCtx` que chega às tasks É a config — quem marca espera (run_one,
    /// descoberta) e quem consulta site de molho (claim do tick) parte daqui.
    /// `Arc`: os clones da config compartilham o MESMO relógio.
    pub site_clock: Arc<SiteClock>,
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
            gate_hourly: 4,
            discovery_interval_ms: 3_600_000,
            series_enabled: true,
            listing_max_pages_per_round: crate::listing::cursor::LISTING_ROUND_MAX_PAGES,
            site_clock: Arc::new(SiteClock::new()),
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
    /// 429/503 com o prazo que o site pediu (`Retry-After` já com piso e
    /// teto — `site_clock::retry_after_capped`). NÃO é falha: não entrega,
    /// não queima `tries` e põe o site inteiro de molho. O `label` viaja
    /// porque o store decide pelo PREFIXO exato `http_429`/`http_503`
    /// (contrato textual da Fase 0) e o `from_work` não recebe status cru.
    Deferred { retry_after_ms: u64, label: String },
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

// O `impl MarkResult` (from_work/from_deferred) mora em `site_clock.rs` —
// relógio e réguas de espera são a mesma decisão, e a catraca de 400 linhas
// não comportava os dois arquivos cheios.

/// Snapshot do status do motor (para o painel).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MotorStatus {
    pub active: bool,
    pub sites: Vec<SiteStatus>,
    pub pages_this_hour: u32,
    pub global_paused: bool,
    /// Sites de molho agora (Fase 0): site e instante de volta. `default`
    /// mantém o JSON antigo consumível (painel defasado não quebra).
    #[serde(default)]
    pub holds: Vec<SiteHold>,
    /// 429/503 vistos desde o boot — o termômetro do problema que a Fase 0
    /// fecha (Vaca: 154 em 40 min antes do relógio por site).
    #[serde(default)]
    pub deferred_count: u32,
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
    /// Pendências de portão (BLUDV): não é falha nem `no-torrent` — o
    /// executor de fundo paga fora do passo e a linha vira `done`. O painel
    /// precisa vê-las para não parecer acúmulo de erro.
    pub gate_pending: u32,
}
