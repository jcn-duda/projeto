//! Executor de fundo das pendências de portão do BLUDV (`gate-pending`).
//!
//! O parser marca o post como pendente de portão; ESTE executor paga FORA do
//! passo de raspagem: nunca no caminho da resposta, nunca dentro do prazo do
//! passo (o pagamento usa ~30s de FlareSolverr e não cabe em `step_deadline_ms`).
//! Freios, nesta ordem (barato → caro): 1) faixa Flare ocupada pula a rodada
//! (o solver é UM por vez e é o mesmo da busca ao vivo); 2) teto por hora
//! (`CRAWL_GATE_HOURLY`) — estourado, os pendentes ficam para a rodada
//! seguinte; 3) ociosidade pelo MESMO critério do freio de tráfego do raspador
//! (`recent_user_traffic`, mecanismo reusado, não duplicado).
//!
//! Dedupe por portão: o magnet obtido é gravado durável no `crawl_state`
//! (`gate-magnet:<gate>`) ANTES da entrega; se a entrega falhar, a rodada
//! seguinte re-entrega SEM pagar de novo. Pendência nunca vira veneno: erro do
//! resolver não toca `tries` nem backoff — o post segue `gate-pending`.
//!
//! A resolução usa o RESOLVER LOCAL ([`HttpGateResolver`], porta 8700 do
//! bludv, modo bloqueante `wait=1`). Ao resolver, a release é gravada no
//! acervo pela MESMA via do raspador (`POST /internal/crawl-result` ao Node)
//! — commit diferido.

mod config;
mod resolver;

pub use config::GateExecutorConfig;
pub use resolver::{FlareProbe, GateFuture, GateResolver, HttpGateResolver};

use std::collections::HashSet;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;
use tokio::time::interval;

use crate::motor::types::{now_ms, CrawlRawItem, CrawlResultStatus, CrawlWorkResult, MotorConfig};
use crate::page_engine::kind_from;
use crate::profile_parsers::{release_title, ResolverLink};
use crate::sidecar::activity::recent_user_traffic;
use crate::sidecar::http_client::SidecarHttpClient;
use crate::store::ops::{CrawlStore, GateRow, MarkResult, StoreError};

/// Prefixo do estado durável que prova que o portão JÁ FOI PAGO (o magnet está
/// lá). A cadeia do resolver tem cache, mas o dedupe evita nem chamar.
const PAID_STATE_PREFIX: &str = "gate-magnet:";

/// O que uma rodada fez (legível no log e nos testes).
#[derive(Debug, Clone, PartialEq)]
pub struct GateRoundReport {
    /// Posts tomados da fila de pendências.
    pub claimed: usize,
    /// Pagamentos concluídos (magnet entregue ao Node e linha fechada).
    pub paid: usize,
    /// Motivo de pular a rodada INTEIRA (antes de tomar qualquer post).
    pub skipped: Option<&'static str>,
}

/// Runtime volátil do executor (janela do teto + dedupe em memória).
struct GateRuntime {
    spent_this_hour: u32,
    hour_started_at: i64,
    /// Portões pagos NESTA janela: cinto de segurança do dedupe durável.
    paid_window: HashSet<String>,
}

/// Destino de UM post na rodada.
#[derive(Debug, Clone, Copy, PartialEq)]
enum RowOutcome {
    /// Pago e gravado no acervo.
    Paid,
    /// Continua pendente (falha do resolver ou da entrega) — sem veneno.
    Pending,
    /// Nem chegou a pagar (dedupe).
    Skipped,
}

/// Executor de fundo: uma rodada a cada `interval_ms`, com os três freios e o
/// dedupe. O store é a MESMA régua do motor (`spawn_blocking` + Mutex padrão).
pub struct GateExecutor {
    cfg: GateExecutorConfig,
    /// Régua do motor para o `MarkResult::from_work` (o fechamento da linha
    /// paga tem que bater com o que o motor faria).
    tuning: MotorConfig,
    http: Arc<SidecarHttpClient>,
    resolver: Arc<dyn GateResolver>,
    flare: Arc<dyn FlareProbe>,
    store: Arc<StdMutex<CrawlStore>>,
    state: AsyncMutex<GateRuntime>,
}

/// SQLite fora da thread async — mesma forma do loop do motor.
async fn with_store<T, F>(store: Arc<StdMutex<CrawlStore>>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&CrawlStore) -> Result<T, StoreError> + Send + 'static,
{
    let dentro = tokio::task::spawn_blocking(move || -> Result<T, String> {
        let guard = store.lock().map_err(|e| format!("lock do store: {e}"))?;
        f(&guard).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?;
    dentro
}

/// Chave do estado durável do pagamento (por site).
fn paid_state_key(gate: &str) -> String {
    format!("{PAID_STATE_PREFIX}{gate}")
}

impl GateExecutor {
    pub fn new(
        cfg: GateExecutorConfig,
        tuning: MotorConfig,
        store: Arc<StdMutex<CrawlStore>>,
        http: Arc<SidecarHttpClient>,
        resolver: Arc<dyn GateResolver>,
        flare: Arc<dyn FlareProbe>,
    ) -> Self {
        Self {
            cfg,
            tuning,
            http,
            resolver,
            flare,
            store,
            state: AsyncMutex::new(GateRuntime {
                spent_this_hour: 0,
                hour_started_at: 0,
                paid_window: HashSet::new(),
            }),
        }
    }

    /// Loop do executor. Roda em task própria (`tokio::spawn`); erro de rodada
    /// é log, nunca derruba o executor.
    pub async fn run(self: Arc<Self>) {
        let mut ticker = interval(Duration::from_millis(self.cfg.interval_ms.max(1_000)));
        loop {
            ticker.tick().await;
            match self.run_round().await {
                Ok(report) => {
                    if report.skipped.is_some() || report.claimed > 0 {
                        eprintln!(
                            "[gate] rodada: pagos={} tomados={} {}",
                            report.paid,
                            report.claimed,
                            report.skipped.unwrap_or("")
                        );
                    }
                }
                Err(e) => eprintln!("[gate] rodada falhou (continuando): {e}"),
            }
        }
    }

    /// UMA rodada: freios → lote → pagamento → gravação no acervo.
    pub async fn run_round(&self) -> Result<GateRoundReport, String> {
        let now = now_ms();
        self.roll_window(now).await;
        // 1. Faixa Flare ocupada: nem consulta o Node. O solver é um por vez.
        if self.flare.flare_busy() {
            return Ok(GateRoundReport {
                claimed: 0,
                paid: 0,
                skipped: Some("flare-ocupado"),
            });
        }
        // 2. Teto por hora: pendentes ficam para a rodada seguinte.
        let restante = {
            let rt = self.state.lock().await;
            self.cfg.hourly_cap.saturating_sub(rt.spent_this_hour)
        };
        if restante == 0 {
            return Ok(GateRoundReport {
                claimed: 0,
                paid: 0,
                skipped: Some("teto-horario"),
            });
        }
        // 3. Freio de tráfego: MESMO critério do raspador (fail-closed já
        //    embutido no `recent_user_traffic`).
        if recent_user_traffic(&self.http, self.cfg.idle_window_ms).await {
            return Ok(GateRoundReport {
                claimed: 0,
                paid: 0,
                skipped: Some("usuario-ativo"),
            });
        }

        let limite = restante as usize;
        let batch = with_store(self.store.clone(), move |db| db.take_gate_batch(limite))
            .await
            .map_err(|e| format!("store: {e}"))?;
        if batch.is_empty() {
            return Ok(GateRoundReport {
                claimed: 0,
                paid: 0,
                skipped: None,
            });
        }

        let mut paid = 0usize;
        for g in &batch {
            // Pendente/Skipped: sem veneno, a linha segue como está.
            if self.process_row(g).await == RowOutcome::Paid {
                paid += 1;
            }
        }
        Ok(GateRoundReport {
            claimed: batch.len(),
            paid,
            skipped: None,
        })
    }

    /// Fecha a janela do teto e esquece o dedupe em memória quando ela vence.
    async fn roll_window(&self, now: i64) {
        let mut rt = self.state.lock().await;
        if rt.hour_started_at == 0 || now - rt.hour_started_at >= self.cfg.hour_window_ms as i64 {
            rt.hour_started_at = now;
            rt.spent_this_hour = 0;
            rt.paid_window.clear();
        }
    }

    /// Pagamento de UM post pendente: dedupe → resolver → gravação.
    async fn process_row(&self, g: &GateRow) -> RowOutcome {
        // Dedupe em memória: pago nesta janela, nunca de novo (o estado
        // durável é consultado logo abaixo; este cobre a corrida entre o
        // take e a gravação da mesma rodada).
        if self.state.lock().await.paid_window.contains(&g.gate) {
            return RowOutcome::Skipped;
        }
        // Dedupe durável: magnet já obtido em rodada anterior (a entrega pode
        // ter falhado ou o processo morrido após o pagamento). Re-entrega SEM
        // pagar de novo — e sem consumir o teto: o FlareSolverr não é tocado.
        let site = g.row.site.clone();
        let chave = paid_state_key(&g.gate);
        let pago_antes = with_store(self.store.clone(), move |db| db.get_state(&site, &chave))
            .await
            .ok()
            .flatten()
            .filter(|m| m.starts_with("magnet:"));
        if let Some(magnet) = pago_antes {
            return match self.deliver(g, &magnet).await {
                Ok(()) => RowOutcome::Paid,
                Err(e) => {
                    eprintln!(
                        "[gate] {} {}: re-entrega falhou: {e}",
                        g.row.site, g.row.url_key
                    );
                    RowOutcome::Pending
                }
            };
        }

        // Pagamento pelo resolver local (FORA do passo, fora de qualquer
        // prazo do motor — este await é livre).
        let magnet = match self.resolver.resolve(&g.gate, &g.row.url).await {
            Ok(m) => m,
            Err(e) => {
                // Falha do resolver: pendente, sem veneno. O custo é real
                // (a tentativa de pagamento acontece): cobrado no teto.
                eprintln!(
                    "[gate] {} {}: pagamento não saiu: {e}",
                    g.row.site, g.row.url_key
                );
                let mut rt = self.state.lock().await;
                rt.spent_this_hour = rt.spent_this_hour.saturating_add(1);
                return RowOutcome::Pending;
            }
        };

        // Prova do pagamento ANTES da entrega: se o processo morrer entre as
        // duas, a próxima rodada re-entrega sem pagar de novo.
        let site = g.row.site.clone();
        let chave = paid_state_key(&g.gate);
        let gravado = magnet.clone();
        if let Err(e) = with_store(self.store.clone(), move |db| {
            db.set_state(&site, &chave, &gravado)
        })
        .await
        {
            eprintln!(
                "[gate] {} {}: estado do pagamento não gravado: {e}",
                g.row.site, g.row.url_key
            );
        }

        match self.deliver(g, &magnet).await {
            Ok(()) => {
                let mut rt = self.state.lock().await;
                rt.paid_window.insert(g.gate.clone());
                rt.spent_this_hour = rt.spent_this_hour.saturating_add(1);
                RowOutcome::Paid
            }
            Err(e) => {
                // Magnet pago e durável: a entrega falhou, tente de novo na
                // próxima rodada (re-entrega, sem novo pagamento).
                eprintln!(
                    "[gate] {} {}: entrega após pagamento falhou: {e}",
                    g.row.site, g.row.url_key
                );
                let mut rt = self.state.lock().await;
                rt.spent_this_hour = rt.spent_this_hour.saturating_add(1);
                RowOutcome::Pending
            }
        }
    }

    /// Entrega ao acervo pela MESMA via do raspador (`POST
    /// /internal/crawl-result`) e fechamento da linha no store (padrão de
    /// commit diferido: o Node primeiro, o store depois — igual ao `run_one`).
    async fn deliver(&self, g: &GateRow, magnet: &str) -> Result<(), String> {
        let work = self.work_of(g, magnet);
        self.http
            .post_crawl_result(&work)
            .await
            .map_err(|e| format!("entrega ao node: {e}"))?;
        let mark = MarkResult::from_work(&g.row, &work, true, &self.tuning, now_ms());
        let (site, url_key) = (g.row.site.clone(), g.row.url_key.clone());
        with_store(self.store.clone(), move |db| {
            db.mark_result(&site, &url_key, &mark)?;
            // O portão foi pago e gravado: a pendência sai da fila de portões.
            db.clear_gate(&site, &url_key)
        })
        .await
        .map_err(|e| format!("store: {e}"))
    }

    /// `CrawlWorkResult` do post pago, com o título da release pela MESMA
    /// régua do raspador (`release_title`: post dá nome/ano, magnet completa).
    fn work_of(&self, g: &GateRow, magnet: &str) -> CrawlWorkResult {
        // Post sem `<h1>` colhido: o magnet (dn=) é a matéria-prima honesta.
        let bruto = if g.title.trim().is_empty() {
            magnet.to_string()
        } else {
            g.title.clone()
        };
        let post_year = (g.year > 0).then_some(g.year as u32);
        let link = ResolverLink {
            url: magnet.to_string(),
            ..Default::default()
        };
        let titulo = release_title(&bruto, post_year, &link, None);
        CrawlWorkResult {
            url: g.row.url.clone(),
            url_key: g.row.url_key.clone(),
            site: g.row.site.clone(),
            status: CrawlResultStatus::Done,
            imdb: (!g.imdb.is_empty()).then(|| g.imdb.clone()),
            title: (!g.title.is_empty()).then(|| g.title.clone()),
            year: (g.year > 0).then_some(g.year),
            kind: kind_from(&g.kind),
            releases: vec![CrawlRawItem {
                title: titulo,
                magnet: Some(magnet.to_string()),
                link: None,
                size: None,
                seeders: None,
                tracker: Some("BLUDV".to_string()),
                // Acervo é BR-dublado e o post é do BLUDV (100% BR).
                is_br: true,
            }],
            groups: Vec::new(),
            unlocated: Vec::new(),
            progress: None,
            // Um pagamento custou um pedido ao solver (régua do `to_work`).
            request_cost: 1,
            error: String::new(),
            gate: None,
        }
    }
}

#[cfg(test)]
#[path = "gate/support.rs"]
mod support;

#[cfg(test)]
#[path = "gate_tests.rs"]
mod tests;
