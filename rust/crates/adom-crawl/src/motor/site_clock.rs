//! Relógio e réguas de espera POR SITE do motor (Fase 0 do plano do 429).
//!
//! O Vaca (`vacatorrent`) devolvia 429 em massa (154 em 40 min em 2026-11-02)
//! porque o tick cobrava TODOS os sites com o mesmo `CRAWL_DELAY_MS` global e
//! tratava 429 como falha comum — queimando `tries` até virar `error` terminal.
//! Duas peças fecham isto:
//!
//! - [`SiteClock`]: memória do processo com o instante em que cada site volta
//!   a aceitar trabalho — mesma ideia do `DiscoverClock` de `discovery_tick.rs`
//!   (agenda de processo, não estado do acervo: restart zera, e zerar é seguro
//!   porque a régua PERSISTIDA vive no `next_at` de cada linha).
//! - o desfecho ADIÁVEL ([`PageOutcome::Deferred`](super::types::PageOutcome)):
//!   429/503 não entregam, não logam erro e não queimam `tries` — a linha volta
//!   `pending` com `next_at` no prazo que o site pediu, e o site INTEIRO
//!   descansa por ele.
//!
//! As réguas de retorno persistido (`from_work`/`from_deferred`) moram aqui
//! junto do relógio de propósito: decidir QUANDO uma linha volta é a mesma
//! decisão de QUANTO um site descansa, e as duas estouram a catraca de 400
//! linhas se ficarem separadas (`types.rs` e `loop.rs` já estavam cheios).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex as StdMutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::r#loop::{with_store, BatchCtx, TaskReport};
use super::types::{error_backoff_ms, now_ms, CrawlResultStatus, CrawlWorkResult, MotorConfig};
use crate::mico_net::throttle::DEFAULT_MAX_RETRY_AFTER_MS;
use crate::store::ops::{MarkResult, UrlRow};

// ─── Réguas numéricas (tudo ajustável começa aqui, não espalhado) ───────────

/// Delay efetivo do Vaca ENTRE páginas — PROVISÓRIO, a medir.
///
/// 4 s por página é a aposta conservadora para um site que devolvia 429 com o
/// delay global de 1 s. Quando o contador de adiamentos (ver `deferred_count`
/// no `/status`) mostrar dias limpos, baixe aqui e remede. Site sem entrada
/// nesta tabela segue o `delay_ms` da config, como sempre.
pub const VACA_DELAY_MS: u64 = 4_000;

/// Teto do descanso do site após UMA rodada COMPLETA de descoberta: a rodada
/// gasta dezenas de requisições seguidas, mas 15 min já é mais que qualquer
/// backoff de página — além disso é gritar, é queimar fila à toa.
pub const DISCOVERY_HOLD_CAP_MS: u64 = 15 * 60_000;

/// Tentativas a partir de que a linha é tratada como PERSISTENTE (Fase 2.3):
/// dorme 7 dias em vez de re-tentar no backoff curto. A linha NÃO é apagada —
/// o "Reprocessar erros" do painel continua a alcançando.
pub const MAX_PERSISTENT_TRIES: u32 = 20;

/// Descanso da linha persistente (7 dias, em ms).
pub const PERSISTENT_BACKOFF_MS: i64 = 7 * 24 * 3_600_000;

/// `Retry-After` quando o site NÃO manda o header: 60 s, o piso conservador
/// que a Fase 0 fixou para 429/503 sem prazo explícito.
pub const DEFERRED_DEFAULT_MS: u64 = 60_000;

// ─── Regras puras de espera ──────────────────────────────────────────────────

/// `Retry-After` efetivo: o que o site mandou, com piso e teto.
///
/// Piso de 1 s: `Retry-After: 0` é martelada. Teto: o MESMO do Mico
/// ([`DEFAULT_MAX_RETRY_AFTER_MS`]) — um header mentiroso de horas não pode
/// parar um site inteiro sem ninguém perceber.
pub fn retry_after_capped(raw: Option<u64>) -> u64 {
    raw.unwrap_or(DEFERRED_DEFAULT_MS)
        .clamp(1_000, DEFAULT_MAX_RETRY_AFTER_MS)
}

/// Delay efetivo ENTRE PÁGINAS do site: a tabela vence a config global.
///
/// É aqui que o override por site entra UM dia; hoje é tabela const porque o
/// override do painel (`site_config_of`) vive em KV entre processos e o laço
/// não o consome — ligá-lo sem a leitura cruzada seria invenção.
pub fn delay_efetivo(site: &str, config_delay_ms: u64) -> u64 {
    match site {
        "vacatorrent" => VACA_DELAY_MS,
        _ => config_delay_ms,
    }
}

/// O erro é ADIÁVEL (429/503)? Pelo PREFIXO exato do rótulo — é o MESMO texto
/// que o store olha para não incrementar `tries` (contrato textual da Fase 0:
/// nenhum campo novo em `MarkResult`, a convenção é o rótulo).
fn error_adiavel(error: &str) -> bool {
    error.starts_with("http_429") || error.starts_with("http_503")
}

// ─── O relógio por site ──────────────────────────────────────────────────────

/// Hold de UM site para o painel (quando volta a aceitar trabalho).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteHold {
    pub site_id: String,
    pub until_ms: i64,
}

/// Estado interno: `site → until_ms`.
type Holds = HashMap<String, i64>;

/// Relógio de espera POR SITE (memória do processo).
///
/// `wait` só ESTENDE a espera: um 429 com `Retry-After: 60` não pode ser
/// encurtado pelo delay de página de 4 s que vier atrás. Compartilha-se por
/// `Arc` (o `MotorConfig` é `Clone` e carrega o relógio a cada `BatchCtx`):
/// a struct interna não deriva `Clone` — clonar um relógio seria criar
/// verdades divergentes sobre quem está em espera.
#[derive(Debug, Default)]
pub struct SiteClock {
    holds: StdMutex<Holds>,
    /// Quantos 429/503 o processo viu — o termômetro do problema que a Fase 0
    /// fecha (era 154 em 40 min antes do relógio).
    deferred_count: AtomicU32,
}

impl SiteClock {
    pub fn new() -> Self {
        Self::default()
    }

    /// Marca o site como ocupado ATÉ `until_ms` (só estende a espera).
    pub fn wait(&self, site: &str, until_ms: i64) {
        let mut holds = self.locked();
        holds
            .entry(site.to_string())
            .and_modify(|at| {
                if until_ms > *at {
                    *at = until_ms;
                }
            })
            .or_insert(until_ms);
    }

    /// Instante em que o site volta (0 = nunca foi marcado).
    pub fn until(&self, site: &str) -> i64 {
        self.locked().get(site).copied().unwrap_or(0)
    }

    /// Sites em espera AGORA — alimenta o `skip_sites` do claim de páginas e
    /// o rodízio da descoberta. Ordenado: o log do painel tem de ser estável.
    pub fn waiting_sites(&self, now: i64) -> Vec<String> {
        let mut sites: Vec<String> = self
            .locked()
            .iter()
            .filter(|(_, at)| **at > now)
            .map(|(site, _)| site.clone())
            .collect();
        sites.sort();
        sites
    }

    /// Holds vigentes para o `/status`, ordenados por site.
    pub fn holds(&self, now: i64) -> Vec<SiteHold> {
        let mut holds: Vec<SiteHold> = self
            .locked()
            .iter()
            .filter(|(_, at)| **at > now)
            .map(|(site, at)| SiteHold {
                site_id: site.clone(),
                until_ms: *at,
            })
            .collect();
        holds.sort_by(|a, b| a.site_id.cmp(&b.site_id));
        holds
    }

    /// Conta mais um adiamento (chamado no passo do 429/503).
    pub fn count_deferred(&self) {
        self.deferred_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Total de adiamentos desde o boot (painel).
    pub fn deferred_count(&self) -> u32 {
        self.deferred_count.load(Ordering::Relaxed)
    }

    /// Lock com recuperação de poison: um panic em outro thread não trava o
    /// relógio de todos (o dado é só `site → ms`, sempre recuperável).
    fn locked(&self) -> MutexGuard<'_, Holds> {
        self.holds.lock().unwrap_or_else(|p| p.into_inner())
    }
}

// ─── Réguas de retorno da linha (movidas de `types.rs` pela catraca) ────────

/// Rótulo persistido — tem que bater com os status que `counters()` entende.
fn status_label(status: &CrawlResultStatus) -> &'static str {
    use CrawlResultStatus as S;
    match status {
        S::Done => "done",
        S::NoTorrent => "no-torrent",
        S::GatePending => "gate-pending",
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

impl MarkResult {
    /// Traduz o resultado da página na escrita do `crawl_url`.
    ///
    /// Espelha `applyResult` de `crawl-store-rules.ts` com uma adaptação ao
    /// CONTRATO do store Rust: `mark_result` volta a linha para `pending` sempre
    /// que `next_at > 0`. Logo, o retry vive em `next_at` (a linha fica
    /// `pending`) e o esgotamento de `tries` é o único caso terminal `error` —
    /// recuperável pelo "Reprocessar erros" do painel (`requeue_errors`).
    ///
    /// ASSINATURA CONGELADA: `gate.rs` e `gate_pending.rs` já a chamam.
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
        // Fase 0: 429/503 NUNCA é esgotamento — o site pediu espera, não a URL
        // morreu. Chega aqui pelo caminho textual (sub-fetch do Vaca, adapters
        // que falam String): o store não incrementa `tries` pelo prefixo, então
        // a linha orbita em `pending` até o site sarar.
        let adiavel = error_adiavel(&error);
        // Recuo longo (Fase 2.3): erro PERSISTENTE (≥ 20 tentativas, não
        // adiável) dorme 7 dias — para de martelar sem apagar a linha.
        let proximo = if tentativas >= MAX_PERSISTENT_TRIES && !adiavel {
            now.saturating_add(PERSISTENT_BACKOFF_MS)
        } else if esgotado && !adiavel {
            0
        } else {
            now + error_backoff_ms(cfg.retry_base_ms, cfg.error_backoff_cap_ms, tentativas) as i64
        };
        Self {
            status: "error".to_string(),
            releases: 0,
            progress: String::new(),
            error: if error.is_empty() {
                "erro".to_string()
            } else {
                error
            },
            next_at: proximo,
            ..base
        }
    }

    /// Desfecho do ADIAMENTO (429/503 com `Retry-After`).
    ///
    /// `status: "error"` NÃO-terminal por convenção textual: o store olha o
    /// PREFIXO do `error` (`http_429`/`http_503` — o Display estável do
    /// `CrawlFetchError::HttpError`) e não incrementa `tries`; e como
    /// `next_at > 0`, o `mark_result` grava `pending`. Nenhum campo novo em
    /// `MarkResult` — o contrato é o rótulo, e quebrá-lo seria silencioso.
    pub fn from_deferred(
        row: &UrlRow,
        label: &str,
        retry_after_ms: u64,
        request_cost: u32,
        now: i64,
    ) -> Self {
        Self {
            status: "error".to_string(),
            imdb: row.imdb.clone(),
            title: None,
            year: None,
            releases: 0,
            error: label.to_string(),
            progress: String::new(),
            next_at: now.saturating_add(retry_after_ms.max(1) as i64),
            request_cost,
        }
    }
}

// ─── O passo do adiamento (chamado pelo `run_one`) ──────────────────────────

/// Passo do 429/503 com prazo no [`run_one`](super::r#loop).
///
/// - NÃO entrega ao ingest (`delivered: false`): não há página;
/// - SEM log de ERRO (não é falha — é o site dizendo "calma"; o eprintln
///   abaixo é informativo, uma linha por adiamento);
/// - o site INTEIRO descansa o MAIOR entre o prazo pedido e o delay efetivo:
///   um `Retry-After` curto não pode fazer o Vaca martelar em 1 s;
/// - a linha volta `pending` com `next_at` no prazo, SEM queimar `tries`.
pub(super) async fn deferred_step(
    ctx: &BatchCtx,
    row: &UrlRow,
    retry_after_ms: u64,
    label: &str,
) -> TaskReport {
    let now = now_ms();
    let hold = retry_after_ms.max(delay_efetivo(&row.site, ctx.cfg.delay_ms));
    ctx.cfg
        .site_clock
        .wait(&row.site, now.saturating_add(hold as i64));
    ctx.cfg.site_clock.count_deferred();
    eprintln!(
        "[motor] {} {}: adiado ({label}) por {retry_after_ms} ms",
        row.site, row.url_key
    );
    let mark = MarkResult::from_deferred(row, label, retry_after_ms, 1, now);
    let (site, url_key) = (row.site.clone(), row.url_key.clone());
    let alvo = format!("{site} {url_key}");
    if let Err(e) = with_store(ctx.store.clone(), move |db| {
        db.mark_result(&site, &url_key, &mark)
    })
    .await
    {
        eprintln!("[motor] falha ao marcar adiado {alvo}: {e}");
    }
    TaskReport {
        cost: 1,
        delivered: false,
    }
}
