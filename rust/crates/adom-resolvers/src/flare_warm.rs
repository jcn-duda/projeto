//! Warm da sessão Cloudflare usada pela LISTAGEM dos resolvers Flare
//! (BLUDV, RedeTorrent, VacaTorrent).
//!
//! Medido pelo operador: a listagem fria do BLUDV levou 18s (15,5s só de
//! desafio do Cloudflare) e estoura a janela da primeira resposta (~4,7s);
//! quente, 0,17s. Este módulo mantém o `cf_clearance` vivo em fundo puro,
//! buscando a HOME do site pela MESMA sessão/cookies que a listagem usa
//! (`ResolverProfile.flare_sessions` → mapa `FlareSessions` do
//! `adom_crawl::flare`, que é exatamente o que `fetch_text_crawl_accept`
//! consulta no fetch da listagem). Sessão quente → fetch direto barato que
//! NÃO toca o FlareSolverr; sessão morta → o próprio escalonamento do fetch
//! re-resolve via FlareSolverr e regrava a sessão para a próxima busca.
//!
//! Porte (o FlareSolverr atende UMA requisição por vez e é o mesmo da busca
//! ao vivo — nada deste módulo pode entrar na frente de um usuário):
//! - só dispara sem requisição de usuário recente (`LAST_USER_MS`, registrado
//!   nas rotas de tráfego pelo `note_user_middleware`);
//! - se qualquer fetch Flare do resolver está em andamento, ou um warm
//!   anterior não concluiu, PULA o ciclo — nunca enfileira nada no solver;
//! - falha é silenciosa com log: não conta failover no SiteSelector (o warm
//!   não passa por `fetch_with_flare` de propósito) e não corrompe estado;
//!   o ciclo seguinte tenta de novo.
//!
//! Custo por ciclo: UMA requisição leve (a home do domínio ativo) por site
//! Flare do spec, no máximo, em sequência — nunca uma varredura. Prioridade:
//! BLUDV primeiro (site medido e mais usado); os demais mantêm a ordem do
//! spec. `FLARE_WARM_INTERVAL_MS=0` desliga tudo.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use adom_crawl::flare::{fetch_text_crawl_accept, CrawlFetchDeps};
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

use crate::profile::ResolverProfile;

/// Intervalo default entre ciclos: 10min — metade do TTL da sessão Flare
/// (20min, `FLARE_SESSION_TTL_MS`), de modo que um site ocioso renova a
/// sessão bem antes de ela expirar no mapa.
const DEFAULT_INTERVAL_MS: u64 = 600_000;
/// Janela de ociosidade default: 5min sem requisição de usuário. Quem usa o
/// addon em ritmo menor que isso mantém a sessão quente sozinho (as buscas
/// passam pelo mesmo caminho); o warm só serve o período de silêncio.
const DEFAULT_IDLE_MS: i64 = 300_000;
/// Piso dos knobs: um ciclo abaixo de 1min não tem propósito (a sessão
/// renova por uso) e só martela o site; 0 no intervalo é kill-switch.
const MIN_INTERVAL_MS: u64 = 60_000;
const MIN_IDLE_MS: i64 = 60_000;

/// Knobs do laço lidos do env (documentados no `.env.example`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WarmKnobs {
    /// Intervalo entre ciclos (ms). `0` desliga o warm.
    pub interval_ms: u64,
    /// Só dispara se nenhuma requisição de usuário ocorreu há este tempo (ms).
    pub idle_window_ms: i64,
}

/// Parse dos knobs com clamp; valor ausente/lixo cai no default. Função pura
/// para os testes não precisarem tocar env real.
pub fn parse_knobs(interval: Option<&str>, idle: Option<&str>) -> WarmKnobs {
    let interval_ms = interval
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|v| if v == 0 { 0 } else { v.max(MIN_INTERVAL_MS) })
        .unwrap_or(DEFAULT_INTERVAL_MS);
    let idle_window_ms = idle
        .and_then(|v| v.trim().parse::<i64>().ok())
        .map(|v| v.max(MIN_IDLE_MS))
        .unwrap_or(DEFAULT_IDLE_MS);
    WarmKnobs {
        interval_ms,
        idle_window_ms,
    }
}

/// Lê os knobs do env. Chamado uma vez no spawn — o laço não relê env.
pub fn knobs_from_env() -> WarmKnobs {
    let interval = std::env::var("FLARE_WARM_INTERVAL_MS").ok();
    let idle = std::env::var("FLARE_WARM_IDLE_MS").ok();
    parse_knobs(interval.as_deref(), idle.as_deref())
}

/// Estado compartilhado do warm — um por PROCESSO: todos os resolvers do
/// spec dividem o mesmo FlareSolverr (loopback 8191), então o porte é global.
pub struct FlareWarm {
    /// Epoch (ms) da última requisição de usuário em rota de tráfego.
    last_user_ms: AtomicI64,
    /// Fetches Flare do resolver em andamento (qualquer site do processo).
    fetches_in_flight: AtomicI64,
    /// Um warm em andamento → o próximo ciclo pula a vez.
    warm_in_progress: AtomicBool,
}

/// Instância única do processo: o middleware das rotas e o contador de
/// fetches (`flare_fetch.rs`) falam com ela; o laço lê.
pub static GLOBAL_WARM: FlareWarm = FlareWarm::new();

impl FlareWarm {
    pub const fn new() -> Self {
        Self {
            last_user_ms: AtomicI64::new(0),
            fetches_in_flight: AtomicI64::new(0),
            warm_in_progress: AtomicBool::new(false),
        }
    }

    /// Requisição de usuário chegou (rota de tráfego, não healthcheck).
    pub fn note_user(&self, now_ms: i64) {
        self.last_user_ms.store(now_ms, Ordering::Relaxed);
    }

    fn begin_fetch(&self) {
        self.fetches_in_flight.fetch_add(1, Ordering::SeqCst);
    }

    fn end_fetch(&self) {
        self.fetches_in_flight.fetch_sub(1, Ordering::SeqCst);
    }

    /// Guard RAII do contador de fetches: garante o decremento mesmo se o
    /// future do fetch for cancelado (cliente aborta a conexão) — sem isso
    /// um abort vazaria o contador e o warm pararia para sempre.
    pub fn fetch_guard(&self) -> FetchInFlightGuard<'_> {
        self.begin_fetch();
        FetchInFlightGuard(self)
    }

    /// Decisão do ciclo, com relógio injetado (`now_ms`) para teste sem
    /// `tokio::time`. A ordem importa: ocupação vence ociosidade — se há
    /// fetch em andamento, NEM OLHAMOS o relógio de usuário.
    pub fn decide(&self, now_ms: i64, idle_window_ms: i64) -> WarmDecision {
        if self.fetches_in_flight.load(Ordering::SeqCst) > 0
            || self.warm_in_progress.load(Ordering::SeqCst)
        {
            return WarmDecision::SkipBusy;
        }
        let last = self.last_user_ms.load(Ordering::Relaxed);
        // `last == 0` é "nunca houve usuário" (boot): `now - 0` já passa.
        if last > 0 && now_ms - last < idle_window_ms {
            return WarmDecision::SkipRecentUser;
        }
        WarmDecision::Run
    }
}

/// RAII do contador de fetches (ver [`FlareWarm::fetch_guard`]).
pub struct FetchInFlightGuard<'a>(&'a FlareWarm);

impl Drop for FetchInFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.end_fetch();
    }
}

/// RAII da bandeira do ciclo: se o laço for cancelado no meio, a bandeira
/// não fica presa em `true` (que desligaria o warm para sempre).
struct WarmCycleGuard<'a>(&'a FlareWarm);

impl Drop for WarmCycleGuard<'_> {
    fn drop(&mut self) {
        self.0.warm_in_progress.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WarmDecision {
    /// Pode disparar.
    Run,
    /// Fetch de usuário em andamento ou warm anterior não concluiu.
    SkipBusy,
    /// Requisição de usuário dentro da janela de ociosidade.
    SkipRecentUser,
}

/// Performer do warm, boxado: a produção chama [`warm_site`] (rede real);
/// os testes injetam um fake — é o que permite exercitar o laço sem rede.
/// O futuro empresta o profile (HRTB), por isso `Pin<Box<...>>`.
pub type WarmPerformer<'a> = &'a (dyn for<'site, 'warm> Fn(
    &'site ResolverProfile,
    &'warm FlareWarm,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'site>>
    + Send
    + Sync);

/// UMA requisição leve à HOME do domínio ativo, pela MESMA sessão/cookies da
/// listagem. Sessão quente → direto (200 barato, cf_clearance segue vivo);
/// sessão morta → o escalonamento re-resolve via FlareSolverr e regrava a
/// sessão. De propósito NÃO passa por `fetch_with_flare`: a falha do warm
/// não pode contar falha no SiteSelector (dispararia probe/troca de domínio
/// por causa de fundo) nem poluir a contabilidade da busca.
pub(crate) async fn warm_site(profile: &ResolverProfile) -> Result<(), String> {
    let url = profile.selector.url();
    let deps = CrawlFetchDeps {
        allowlist: profile.allowlist.clone(),
        sessions: profile.flare_sessions.clone(),
        solver_url: crate::flare_fetch::SOLVER_URL.to_string(),
        flare_timeout_ms: crate::flare_fetch::FLARE_TIMEOUT_MS,
        direct_timeout_ms: profile.network.timeout_ms,
        max_hops: profile.network.max_hops,
        user_agent: profile.network.user_agent.clone(),
        on_request: None,
    };
    fetch_text_crawl_accept(&url, &deps, crate::flare_fetch::HTML_ACCEPT)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Performer de produção (chama [`warm_site`]). Lifetime nomeado: o futuro
/// empresta só o profile (`'a`), nunca o warm — é o que o `WarmPerformer`
/// exige.
fn perform_warm<'a>(
    profile: &'a ResolverProfile,
    _warm: &FlareWarm,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(warm_site(profile))
}

/// Prioridade do ciclo: BLUDV primeiro (site medido pelo operador e o mais
/// usado); `sort_by_key` é estável, então os demais mantêm a ordem do spec.
pub fn order_by_priority(profiles: &mut [Arc<ResolverProfile>]) {
    profiles.sort_by_key(|p| (p.site_name != "bludv") as u8);
}

/// Um ciclo do laço. Retorna quantas requisições DISPAROU (por site: no
/// máximo 1). Nunca enfileira: qualquer porte devolve 0 sem chamar o
/// performer.
pub async fn cycle_tick(
    profiles: &[Arc<ResolverProfile>],
    warm: &FlareWarm,
    now_ms: i64,
    idle_window_ms: i64,
    warm_one: WarmPerformer<'_>,
) -> usize {
    match warm.decide(now_ms, idle_window_ms) {
        WarmDecision::SkipBusy => {
            eprintln!("[flare-warm] ciclo pulado: fetch em andamento (solver ocupado)");
            0
        }
        WarmDecision::SkipRecentUser => {
            eprintln!("[flare-warm] ciclo pulado: usuário ativo");
            0
        }
        WarmDecision::Run => {
            // Bandeira do ciclo inteiro: dois laços (por bug) nunca enfileiram
            // dois warms no solver — o segundo pula.
            if warm.warm_in_progress.swap(true, Ordering::SeqCst) {
                return 0;
            }
            let _guard = WarmCycleGuard(warm);
            let mut fired = 0;
            for profile in profiles {
                // Porte no meio do ciclo: um usuário chegou enquanto o ciclo
                // rodava — termina educado e devolve a vez.
                if warm.fetches_in_flight.load(Ordering::SeqCst) > 0 {
                    eprintln!("[flare-warm] ciclo abortado no meio: usuário chegou");
                    break;
                }
                fired += 1;
                match warm_one(profile, warm).await {
                    Ok(()) => eprintln!("[flare-warm] {} sessão renovada", profile.site_name),
                    Err(msg) => {
                        // Silencioso: a falha não derruba nada e não conta
                        // failover; o ciclo seguinte tenta de novo.
                        eprintln!("[flare-warm] {} falhou: {msg}", profile.site_name)
                    }
                }
            }
            fired
        }
    }
}

/// Epoch em ms (relógio de parede). O núcleo de decisão (`decide`,
/// `cycle_tick`) recebe `now_ms` injetado — os testes não leem relógio real.
pub fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Middleware registrado UMA vez no `build_router` (server.rs): cada rota de
/// tráfego (search/resolve/dl/api) marca atividade de usuário para o warm
/// pular a vez. Cobrir /resolve aqui também protege contra o warm disparar
/// durante um play (a cadeia do portão fala com o mesmo FlareSolverr).
pub async fn note_user_middleware(req: Request, next: Next) -> Response {
    if counts_as_user(req.uri().path()) {
        GLOBAL_WARM.note_user(now_epoch_ms());
    }
    next.run(req).await
}

/// O healthcheck do container bate em /health de minuto a minuto: não é
/// tráfego de usuário e não pode segurar o warm para sempre.
pub fn counts_as_user(path: &str) -> bool {
    path != "/health"
}

/// Sobe o laço de fundo. Chamado uma vez no `main` com os profiles Flare do
/// spec (`network.uses_flare`). `FLARE_WARM_INTERVAL_MS=0` desliga.
pub fn spawn(profiles: Vec<Arc<ResolverProfile>>) {
    if profiles.is_empty() {
        return;
    }
    let knobs = knobs_from_env();
    if knobs.interval_ms == 0 {
        eprintln!("[flare-warm] desligado (FLARE_WARM_INTERVAL_MS=0)");
        return;
    }
    let mut ordered = profiles;
    order_by_priority(&mut ordered);
    let names: Vec<&str> = ordered.iter().map(|p| p.site_name.as_str()).collect();
    eprintln!(
        "[flare-warm] {} site(s) [{}]; ciclo {}ms; ociosidade {}ms",
        names.len(),
        names.join(","),
        knobs.interval_ms,
        knobs.idle_window_ms
    );
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(knobs.interval_ms));
        // Ciclo atrasado (solve longo) não vira fila de ciclos: atrasa o
        // próximo e segue — mesma razão de nunca enfileirar.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            cycle_tick(
                &ordered,
                &GLOBAL_WARM,
                now_epoch_ms(),
                knobs.idle_window_ms,
                &perform_warm,
            )
            .await;
        }
    });
}

#[cfg(test)]
#[path = "flare_warm_tests.rs"]
mod tests;
