#[cfg(test)]
use super::*;

#[test]
fn test_is_site_level_error_matches() {
    assert!(is_site_level_error("fetch: HTTP 403 Forbidden"));
    assert!(is_site_level_error("403"));
    assert!(is_site_level_error("HTTP 429 Too Many Requests"));
    assert!(is_site_level_error("500 Internal Server Error"));
    assert!(is_site_level_error("502 Bad Gateway"));
    assert!(is_site_level_error("503 Service Unavailable"));
    assert!(is_site_level_error("504 Gateway Timeout"));
    assert!(is_site_level_error("599 Network timeout"));
    assert!(is_site_level_error("blocked_host:evil.example"));
    assert!(is_site_level_error("Challenge required"));
    assert!(is_site_level_error("Cloudflare Ray ID"));
    assert!(is_site_level_error("Just a moment..."));
    assert!(is_site_level_error("JUST A MOMENT"));
    assert!(is_site_level_error("cloudflare"));
}

#[test]
fn test_is_site_level_error_non_matches() {
    assert!(!is_site_level_error("socket hang up"));
    assert!(!is_site_level_error("ECONNREFUSED"));
    assert!(!is_site_level_error("ETIMEDOUT"));
    assert!(!is_site_level_error("JSON parse error"));
    assert!(!is_site_level_error("4030 not error"));
    assert!(!is_site_level_error("1403 not error"));
    assert!(!is_site_level_error("5000 not error"));
    assert!(!is_site_level_error("1500 not error"));
    assert!(!is_site_level_error("4290 not error"));
    assert!(!is_site_level_error(""));
    assert!(!is_site_level_error("HTTP 200 OK"));
}

#[test]
fn test_max_lastmod_valid_dates() {
    let urls = vec![
        "2026-01-01",
        "2026-03-15T01:36:00+00:00",
        "2026-02-01",
        "2026-04-10T10:20:00Z",
    ];
    assert_eq!(max_lastmod(&urls), "2026-04-10T10:20:00Z");

    // Ordenação com fuso horário
    // 12:00 UTC vs 15:00 UTC+4 (que é 11:00 UTC)
    let tz_urls = vec![
        "2026-05-01T15:00:00+04:00", // 11:00 UTC
        "2026-05-01T12:00:00Z",      // 12:00 UTC
    ];
    assert_eq!(max_lastmod(&tz_urls), "2026-05-01T12:00:00Z");
}

#[test]
fn test_max_lastmod_invalid_and_empty() {
    assert_eq!(max_lastmod::<&str>(&[]), "");
    assert_eq!(max_lastmod(&["", ""]), "");

    // Somente inválidas: "corrupt-2026" tem ano parseável (2026), "not-a-date" não tem
    // Comportamento igual a JS Date.parse: "corrupt-2026" -> timestamp válido para 2026
    let invalid = vec!["not-a-date", "corrupt-2026"];
    assert_eq!(max_lastmod(&invalid), "corrupt-2026");

    // Inválida primeiro, depois data válida
    let mixed = vec!["invalid", "2026-01-01", "2026-02-01"];
    assert_eq!(max_lastmod(&mixed), "2026-02-01");

    // Válida primeiro, depois inválida
    let mixed2 = vec!["2026-03-01", "invalid", "2026-01-01"];
    assert_eq!(max_lastmod(&mixed2), "2026-03-01");
}

#[test]
fn test_error_streak_and_site_failure() {
    let mut policy = CrawlPausePolicy::new();
    let limits = PauseLimits::new(3, 10);

    // Erro comum de página: não incrementa error_streak
    let reason = policy.observe_page("/p1", &PageOutcomeSignal::error(false), &limits);
    assert_eq!(reason, None);
    assert_eq!(policy.error_streak(), 0);

    // Erro de site 1
    let reason = policy.observe_page("/p2", &PageOutcomeSignal::error(true), &limits);
    assert_eq!(reason, None);
    assert_eq!(policy.error_streak(), 1);

    // Falha de descoberta do site que não é erro de site: ignorada
    let reason = policy.observe_site_failure("DNS timeout", &limits);
    assert_eq!(reason, None);
    assert_eq!(policy.error_streak(), 1);

    // Falha de descoberta do site que É erro de site: erro 2
    let reason = policy.observe_site_failure("HTTP 502 Bad Gateway", &limits);
    assert_eq!(reason, None);
    assert_eq!(policy.error_streak(), 2);

    // Erro de site 3 -> atinge limite 3!
    let reason = policy.observe_page("/p3", &PageOutcomeSignal::error(true), &limits);
    assert_eq!(reason, Some(AutoPauseReason::ErrorStreak));
    assert_eq!(policy.error_streak(), 3);

    // Descoberta com sucesso zera o streak
    policy.observe_site_success();
    assert_eq!(policy.error_streak(), 0);
}

#[test]
fn test_page_success_resets_streaks() {
    let mut policy = CrawlPausePolicy::new();
    let limits = PauseLimits::new(2, 2);

    policy.observe_page("/e", &PageOutcomeSignal::error(true), &limits);
    assert_eq!(policy.error_streak(), 1);

    // done zera error_streak
    policy.observe_page("/ok", &PageOutcomeSignal::done(1), &limits);
    assert_eq!(policy.error_streak(), 0);

    // erro de site novamente
    policy.observe_page("/e", &PageOutcomeSignal::error(true), &limits);
    assert_eq!(policy.error_streak(), 1);

    // no-work zera error_streak
    policy.observe_page("/nowork", &PageOutcomeSignal::no_work(), &limits);
    assert_eq!(policy.error_streak(), 0);

    // erro de site novamente
    policy.observe_page("/e", &PageOutcomeSignal::error(true), &limits);
    assert_eq!(policy.error_streak(), 1);

    // simulated zera error_streak
    policy.observe_page("/sim", &PageOutcomeSignal::simulated(2), &limits);
    assert_eq!(policy.error_streak(), 0);
}

#[test]
fn test_partial_outcome_signal() {
    let mut policy = CrawlPausePolicy::new();
    let limits = PauseLimits::new(3, 2);

    // Adiciona URL no canário previamente
    policy.observe_page("/item", &PageOutcomeSignal::done(5), &limits);
    assert_eq!(policy.prior_releases.get("/item"), Some(&5));

    // Acumula 1 erro
    policy.observe_page("/err", &PageOutcomeSignal::error(true), &limits);
    assert_eq!(policy.error_streak(), 1);

    // partial zera error_streak e alimenta prior_releases se releases > 0
    policy.observe_page("/item", &PageOutcomeSignal::partial(8), &limits);
    assert_eq!(policy.error_streak(), 0);
    assert_eq!(policy.prior_releases.get("/item"), Some(&8));

    // partial com releases 0 zera error_streak sem alterar canário
    policy.observe_page("/err", &PageOutcomeSignal::error(true), &limits);
    assert_eq!(policy.error_streak(), 1);
    policy.observe_page("/new_item", &PageOutcomeSignal::partial(0), &limits);
    assert_eq!(policy.error_streak(), 0);
    assert_eq!(policy.prior_releases.get("/new_item"), None);
}

#[test]
fn test_layout_canary_transitions() {
    let mut policy = CrawlPausePolicy::new();
    let limits = PauseLimits::new(5, 2);

    // Página sem histórico prévio retornando no-torrent: não dispara canário
    let reason = policy.observe_page("/stream-only", &PageOutcomeSignal::no_torrent(), &limits);
    assert_eq!(reason, None);
    assert_eq!(policy.canary_streak(), 0);

    // Visita que valida torrents em /page1 e /page2
    policy.observe_page("/page1", &PageOutcomeSignal::done(2), &limits);
    policy.observe_page("/page2", &PageOutcomeSignal::done(3), &limits);
    assert_eq!(policy.canary_streak(), 0);

    // Primeira página perde botões -> canary_streak = 1
    let reason = policy.observe_page("/page1", &PageOutcomeSignal::no_torrent(), &limits);
    assert_eq!(reason, None);
    assert_eq!(policy.canary_streak(), 1);

    // Página sã (/ok) zera canary_streak
    policy.observe_page("/ok", &PageOutcomeSignal::done(1), &limits);
    assert_eq!(policy.canary_streak(), 0);

    // /page1 perde botões novamente -> canary_streak = 1
    let reason = policy.observe_page("/page1", &PageOutcomeSignal::no_torrent(), &limits);
    assert_eq!(reason, None);
    assert_eq!(policy.canary_streak(), 1);

    // /page2 perde botões -> canary_streak = 2 -> pausa com Layout!
    let reason = policy.observe_page("/page2", &PageOutcomeSignal::no_torrent(), &limits);
    assert_eq!(reason, Some(AutoPauseReason::Layout));
    assert_eq!(policy.canary_streak(), 2);
}

#[test]
fn test_prior_releases_lru_eviction() {
    let mut policy = CrawlPausePolicy::new().with_prior_max(3);
    let limits = PauseLimits::new(5, 5);

    // Insere 3 páginas
    policy.observe_page("/a", &PageOutcomeSignal::done(1), &limits);
    policy.observe_page("/b", &PageOutcomeSignal::done(2), &limits);
    policy.observe_page("/c", &PageOutcomeSignal::done(3), &limits);
    assert_eq!(policy.prior_releases.len(), 3);

    // Reacessa /a (move /a para o fim da ordem de inserção / LRU)
    policy.observe_page("/a", &PageOutcomeSignal::done(10), &limits);
    assert_eq!(policy.prior_releases.len(), 3);
    assert_eq!(policy.prior_releases.get("/a"), Some(&10));

    // Insere /d -> deve evictar /b (que é a mais antiga não atualizada)
    policy.observe_page("/d", &PageOutcomeSignal::done(4), &limits);
    assert_eq!(policy.prior_releases.len(), 3);
    assert_eq!(policy.prior_releases.get("/b"), None);
    assert_eq!(policy.prior_releases.get("/a"), Some(&10));
    assert_eq!(policy.prior_releases.get("/c"), Some(&3));
    assert_eq!(policy.prior_releases.get("/d"), Some(&4));
}

#[test]
fn test_reset_clears_all_state() {
    let mut policy = CrawlPausePolicy::new();
    let limits = PauseLimits::new(5, 5);

    policy.observe_page("/a", &PageOutcomeSignal::done(2), &limits);
    policy.observe_page("/a", &PageOutcomeSignal::no_torrent(), &limits);
    policy.observe_page("/err", &PageOutcomeSignal::error(true), &limits);

    assert!(policy.error_streak() > 0);
    assert!(policy.canary_streak() > 0);
    assert!(!policy.prior_releases.is_empty());

    policy.reset();

    assert_eq!(policy.error_streak(), 0);
    assert_eq!(policy.canary_streak(), 0);
    assert!(policy.prior_releases.is_empty());
}

#[test]
fn test_zero_or_negative_limits_defaults_to_one() {
    let mut policy = CrawlPausePolicy::new();
    let limits = PauseLimits::new(0, 0);

    // Erro de site pausa imediatamente no primeiro erro pois max(1, 0) == 1
    let reason = policy.observe_page("/err", &PageOutcomeSignal::error(true), &limits);
    assert_eq!(reason, Some(AutoPauseReason::ErrorStreak));

    // Canário com prior prévio pausa imediatamente no primeiro no_torrent
    policy.reset();
    policy.observe_page("/a", &PageOutcomeSignal::done(3), &limits);
    let reason = policy.observe_page("/a", &PageOutcomeSignal::no_torrent(), &limits);
    assert_eq!(reason, Some(AutoPauseReason::Layout));
}

#[test]
fn test_prior_releases_large_scale_eviction() {
    let mut policy = CrawlPausePolicy::new(); // prior_max padrão = 50_000
    assert_eq!(policy.prior_max, PRIOR_MAX);

    // Insere 50_005 itens
    for i in 0..50_005 {
        let url = format!("/page/{}", i);
        policy.remember_prior(&url, 1);
    }

    assert_eq!(policy.prior_releases.len(), 50_000);
    // Os primeiros 5 (0, 1, 2, 3, 4) devem ter sido evictados
    for i in 0..5 {
        let url = format!("/page/{}", i);
        assert_eq!(policy.prior_releases.get(&url), None);
    }
    // Os últimos 5 devem existir
    for i in 50_000..50_005 {
        let url = format!("/page/{}", i);
        assert_eq!(policy.prior_releases.get(&url), Some(&1));
    }
}

#[test]
fn test_serde_and_display() {
    assert_eq!(AutoPauseReason::ErrorStreak.as_str(), "error-streak");
    assert_eq!(AutoPauseReason::Layout.as_str(), "layout");
    assert_eq!(format!("{}", AutoPauseReason::ErrorStreak), "error-streak");
    assert_eq!(format!("{}", AutoPauseReason::Layout), "layout");

    assert_eq!(PageOutcomeKind::Done.as_str(), "done");
    assert_eq!(PageOutcomeKind::NoTorrent.as_str(), "no-torrent");
    assert_eq!(PageOutcomeKind::NoWork.as_str(), "no-work");
    assert_eq!(PageOutcomeKind::Error.as_str(), "error");
    assert_eq!(PageOutcomeKind::Simulated.as_str(), "simulated");
    assert_eq!(PageOutcomeKind::Partial.as_str(), "partial");

    let reason_json = serde_json::to_string(&AutoPauseReason::ErrorStreak).unwrap();
    assert_eq!(reason_json, "\"error-streak\"");
    let reason_de: AutoPauseReason = serde_json::from_str(&reason_json).unwrap();
    assert_eq!(reason_de, AutoPauseReason::ErrorStreak);

    let limits = PauseLimits::default();
    assert_eq!(limits.error_pause_streak, 5);
    assert_eq!(limits.layout_canary, 10);
    let limits_json = serde_json::to_string(&limits).unwrap();
    let limits_de: PauseLimits = serde_json::from_str(&limits_json).unwrap();
    assert_eq!(limits_de, limits);

    let sig = PageOutcomeSignal::done(42);
    assert_eq!(sig.releases_count(), 42);
    let sig_json = serde_json::to_string(&sig).unwrap();
    let sig_de: PageOutcomeSignal = serde_json::from_str(&sig_json).unwrap();
    assert_eq!(sig_de, sig);
}
