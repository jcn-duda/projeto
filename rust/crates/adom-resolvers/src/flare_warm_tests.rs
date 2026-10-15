//! Testes do warm sem rede real: decisões de porte e contagem de requisições
//! com performer fake e relógio (epoch) injetado. Cada teste usa um
//! `FlareWarm` LOCAL — nada toca `GLOBAL_WARM`, então testes paralelos não
//! interferem entre si.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Arc;

use super::{counts_as_user, cycle_tick, order_by_priority, parse_knobs, FlareWarm, WarmDecision, WarmPerformer};
use crate::profile::ResolverProfile;

/// Profile fake: montagem é toda local (registry estático), zero rede.
fn profile(name: &str) -> Arc<ResolverProfile> {
    Arc::new(ResolverProfile::new(
        name,
        &format!("https://{name}.test"),
        vec![],
    ))
}

/// Performer fake que conta chamadas e falha conforme a bandeira — cobre os
/// cenários (a), (b), (c) e (d) do plano sem abrir conexão.
fn counting_performer(
    calls: Arc<AtomicIsize>,
    fail: Arc<AtomicBool>,
) -> impl for<'site, 'warm> Fn(
    &'site ResolverProfile,
    &'warm FlareWarm,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'site>> {
    move |_profile: &ResolverProfile, _warm: &FlareWarm| {
        calls.fetch_add(1, Ordering::SeqCst);
        let fail = fail.clone();
        Box::pin(async move {
            if fail.load(Ordering::SeqCst) {
                Err("falha fake".to_string())
            } else {
                Ok(())
            }
        }) as Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
    }
}

/// Performer fake que simula um usuário chegando durante o PRIMEIRO warm do
/// ciclo (o porte de meio de ciclo tem que pular o site seguinte).
fn user_arrival_performer(
    calls: Arc<AtomicIsize>,
) -> impl for<'site, 'warm> Fn(
    &'site ResolverProfile,
    &'warm FlareWarm,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'site>> {
    move |_profile: &ResolverProfile, warm: &FlareWarm| {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            warm.begin_fetch();
        }
        Box::pin(async { Ok::<(), String>(()) })
            as Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
    }
}

// ── (a) Ocioso → dispara, UMA requisição por site no máximo ─────────────────

#[tokio::test]
async fn ocioso_dispara_uma_requisicao_por_site() {
    let warm = FlareWarm::new();
    let profiles = vec![profile("bludv"), profile("vacatorrent")];
    let calls = Arc::new(AtomicIsize::new(0));
    let fail = Arc::new(AtomicBool::new(false));
    let owner = counting_performer(calls.clone(), fail.clone());
    let performer: WarmPerformer<'_> = &owner;

    // Requisição há 1h, janela de 5min → ocioso.
    assert!(matches!(
        warm.decide(3_600_000, 300_000),
        WarmDecision::Run
    ));
    let fired = cycle_tick(&profiles, &warm, 3_600_000, 300_000, performer).await;
    assert_eq!(fired, 2, "uma requisição por site, nunca mais");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    // Bandeira do ciclo liberada depois.
    assert!(!warm.warm_in_progress.load(Ordering::SeqCst));
}

#[tokio::test]
async fn sem_nunca_ter_hadido_usuario_o_primeiro_ciclo_dispara() {
    // `last_user_ms == 0` (boot sem tráfego): o warm resolve a sessão fria
    // de graça, em fundo, antes do primeiro usuário pagar 18s por ela.
    let warm = FlareWarm::new();
    let profiles = vec![profile("bludv")];
    let calls = Arc::new(AtomicIsize::new(0));
    let fail = Arc::new(AtomicBool::new(false));
    let owner = counting_performer(calls.clone(), fail.clone());
    let performer: WarmPerformer<'_> = &owner;

    assert!(matches!(warm.decide(60_000, 300_000), WarmDecision::Run));
    let fired = cycle_tick(&profiles, &warm, 60_000, 300_000, performer).await;
    assert_eq!(fired, 1);
}

// ── (b) Requisição de usuário recente → não dispara ─────────────────────────

#[tokio::test]
async fn usuario_recente_nao_dispara() {
    let warm = FlareWarm::new();
    // Requisição de usuário há 10s; janela de 5min → pula a vez.
    warm.note_user(3_600_000 - 10_000);
    let profiles = vec![profile("bludv")];
    let calls = Arc::new(AtomicIsize::new(0));
    let fail = Arc::new(AtomicBool::new(false));
    let owner = counting_performer(calls.clone(), fail.clone());
    let performer: WarmPerformer<'_> = &owner;

    assert!(matches!(
        warm.decide(3_600_000, 300_000),
        WarmDecision::SkipRecentUser
    ));
    let fired = cycle_tick(&profiles, &warm, 3_600_000, 300_000, performer).await;
    assert_eq!(fired, 0);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "performer nunca chamado — nada sai para a rede"
    );
}

// ── (c) Fetch em andamento → pula SEM enfileirar ────────────────────────────

#[tokio::test]
async fn fetch_em_andamento_pula_sem_enfileirar() {
    let warm = FlareWarm::new();
    let profiles = vec![profile("bludv"), profile("vacatorrent")];
    let calls = Arc::new(AtomicIsize::new(0));
    let fail = Arc::new(AtomicBool::new(false));
    let owner = counting_performer(calls.clone(), fail.clone());
    let performer: WarmPerformer<'_> = &owner;

    // Um fetch de usuário (listagem, post ou play) em andamento no resolver:
    // o FlareSolverr atende um por vez — o warm nem tenta.
    warm.begin_fetch();
    assert!(matches!(
        warm.decide(3_600_000, 300_000),
        WarmDecision::SkipBusy
    ));
    let fired = cycle_tick(&profiles, &warm, 3_600_000, 300_000, performer).await;
    assert_eq!(fired, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 0, "nada enfileirado no solver");
    warm.end_fetch();

    // Warm anterior não concluído: mesmo porte, pula também.
    warm.warm_in_progress.store(true, Ordering::SeqCst);
    let fired = cycle_tick(&profiles, &warm, 3_600_000, 300_000, performer).await;
    assert_eq!(fired, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn usuario_no_meio_do_ciclo_aborta_o_resto() {
    let warm = FlareWarm::new();
    let profiles = vec![profile("bludv"), profile("vacatorrent")];
    let calls = Arc::new(AtomicIsize::new(0));
    let challenger = user_arrival_performer(calls.clone());
    let challenger_ref: WarmPerformer<'_> = &challenger;

    let fired = cycle_tick(&profiles, &warm, 3_600_000, 300_000, challenger_ref).await;
    assert_eq!(fired, 1, "só o primeiro site rodou; o segundo cedeu a vez");
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Limpa o estado que o próprio teste criou (o warm local é descartado,
    // mas a bandeira/fetch precisam voltar a zero para as checagens de cima).
    warm.end_fetch();
    assert_eq!(warm.fetches_in_flight.load(Ordering::SeqCst), 0);
}

// ── (d) Falha do warm → ciclo seguinte tenta de novo, nada global quebra ────

#[tokio::test]
async fn falha_do_warm_ciclo_seguinte_tenta_de_novo() {
    let warm = FlareWarm::new();
    let profiles = vec![profile("bludv")];
    let calls = Arc::new(AtomicIsize::new(0));
    let fail = Arc::new(AtomicBool::new(true));
    let owner = counting_performer(calls.clone(), fail.clone());
    let performer: WarmPerformer<'_> = &owner;

    // Ciclo 1: falha fake (rede/desafio) — conta tentativa e segue.
    let fired = cycle_tick(&profiles, &warm, 3_600_000, 300_000, performer).await;
    assert_eq!(fired, 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Nada travado: bandeira liberada e decisão volta a Run.
    assert!(!warm.warm_in_progress.load(Ordering::SeqCst));
    assert!(matches!(
        warm.decide(3_600_000 + 600_000, 300_000),
        WarmDecision::Run
    ));

    // Ciclo 2 (performer consertado): tenta de novo e passa.
    fail.store(false, Ordering::SeqCst);
    let fired = cycle_tick(&profiles, &warm, 3_600_000 + 600_000, 300_000, performer).await;
    assert_eq!(fired, 1);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!warm.warm_in_progress.load(Ordering::SeqCst));
}

#[tokio::test]
async fn guard_do_fetch_libera_o_contador_ao_sair() {
    // RAII do contador: cancelamento (drop do future) tem que liberar o porte
    // — sem isso um cliente que aborta a conexão desligava o warm para sempre.
    let warm = FlareWarm::new();
    {
        let _guard = warm.fetch_guard();
        assert!(matches!(
            warm.decide(1_000, 300_000),
            WarmDecision::SkipBusy
        ));
    }
    // Guard dropado → contador zero → decisão volta a considerar o relógio.
    assert!(matches!(warm.decide(1_000, 300_000), WarmDecision::Run));
}

// ── Knobs, prioridade e filtro de rota ──────────────────────────────────────

#[test]
fn knobs_defaults_e_overrides() {
    let defaults = parse_knobs(None, None);
    assert_eq!(defaults.interval_ms, 600_000);
    assert_eq!(defaults.idle_window_ms, 300_000);

    // Override respeitado…
    let custom = parse_knobs(Some("900000"), Some("120000"));
    assert_eq!(custom.interval_ms, 900_000);
    assert_eq!(custom.idle_window_ms, 120_000);

    // …mas clamped ao piso (ciclo de 500ms só martelaria o site).
    let clamped = parse_knobs(Some("500"), Some("10"));
    assert_eq!(clamped.interval_ms, 60_000);
    assert_eq!(clamped.idle_window_ms, 60_000);

    // Kill-switch explícito.
    assert_eq!(parse_knobs(Some("0"), None).interval_ms, 0);

    // Lixo cai no default.
    let lixo = parse_knobs(Some("abc"), Some("xyz"));
    assert_eq!(lixo.interval_ms, 600_000);
    assert_eq!(lixo.idle_window_ms, 300_000);
}

#[test]
fn prioridade_bludv_primeiro_e_estavel_para_os_demais() {
    let mut profiles = vec![
        profile("vacatorrent"),
        profile("bludv"),
        profile("redetorrent"),
    ];
    order_by_priority(&mut profiles);
    assert_eq!(profiles[0].site_name, "bludv");
    assert_eq!(profiles[1].site_name, "vacatorrent", "ordem do spec mantida");
    assert_eq!(profiles[2].site_name, "redetorrent", "ordem do spec mantida");
}

#[test]
fn healthcheck_nao_e_usuario_rotas_de_trafego_sao() {
    assert!(!counts_as_user("/health"));
    assert!(counts_as_user("/search"));
    assert!(counts_as_user("/resolve"));
    assert!(counts_as_user("/dl"));
    assert!(counts_as_user("/api"));
}
