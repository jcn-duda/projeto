//! Testes do relógio e das réguas de espera por site (Fase 0 do 429).
//!
//! Dois contratos frágeis moram aqui e são os que regrediriam EM SILÊNCIO:
//! 1. 429/503 não queimam tentativa: o rótulo (`http_429`) é TEXTUAL e o store
//!    decide por prefixo — mudar o rótulo quebraria o store sem erro de
//!    compilação. Estes testes são a cerca.
//! 2. O `wait` só estende: um Retry-After curto atrás de um hold maior não
//!    encurta o descanso do site.

use std::collections::HashMap;

use super::site_clock::*;
use super::types::{error_backoff_ms, error_work, now_ms, MotorConfig, PageOutcome};
use crate::net::types::retry_after_ms_from_headers;
use crate::page_engine::fetch_error_of;
use crate::store::ops::{MarkResult, UrlRow};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Linha de fila de teste (o `tries` controlado é o que decide terminalidade).
fn linha(site: &str, tries: u32) -> UrlRow {
    UrlRow {
        site: site.to_string(),
        url: format!("https://exemplo.tv/{site}/pagina"),
        url_key: format!("{site}-chave"),
        kind: "movie".to_string(),
        status: "pending".to_string(),
        lastmod: String::new(),
        imdb: Some("tt0000001".to_string()),
        tries,
        next_at: 0,
        checked_at: 0,
        releases: 0,
        error: String::new(),
        progress: String::new(),
        added_at: 0,
    }
}

/// Config padrão exceto o teto de tentativas (o recuo longo precisa de tries
/// alto SEM esgotar antes).
fn cfg(max_tries: u32) -> MotorConfig {
    MotorConfig {
        max_tries,
        ..Default::default()
    }
}

// ─── O relógio ───────────────────────────────────────────────────────────────

#[test]
fn site_em_espera_sai_de_waiting_sites() {
    let clock = SiteClock::new();
    let agora = now_ms();
    assert!(
        clock.waiting_sites(agora).is_empty(),
        "relógio novo: ninguém de molho"
    );
    clock.wait("vacatorrent", agora + 60_000);
    clock.wait("bludv", agora - 1); // vencido no passado: não é espera
    assert_eq!(
        clock.waiting_sites(agora),
        vec!["vacatorrent".to_string()],
        "só o hold VIGENTE bloqueia o claim"
    );
    assert!(clock.until("vacatorrent") > agora);
    assert_eq!(clock.until("bludv"), agora - 1, "until devolve o valor cru");
    // Passado o prazo, o site volta SEM nenhuma ação externa.
    assert!(clock.waiting_sites(agora + 61_000).is_empty());
}

#[test]
fn wait_so_estende_a_espera() {
    let clock = SiteClock::new();
    let agora = now_ms();
    clock.wait("vacatorrent", agora + 60_000);
    // Um delay de página de 4 s NÃO encurta o Retry-After de 60 s.
    clock.wait("vacatorrent", agora + 4_000);
    assert!(clock.until("vacatorrent") >= agora + 60_000);
    // Mas um adiamento MAIOR estende.
    clock.wait("vacatorrent", agora + 120_000);
    assert!(clock.until("vacatorrent") >= agora + 120_000);
}

#[test]
fn delay_efetivo_vaca_tem_default_proprio() {
    assert_eq!(
        delay_efetivo("vacatorrent", 1_000),
        VACA_DELAY_MS,
        "o Vaca não segue o delay global: default PROVISÓRIO de 4 s, a medir"
    );
    assert_eq!(
        delay_efetivo("bludv", 1_000),
        1_000,
        "site sem entrada na tabela usa a config global, como sempre"
    );
}

#[test]
fn contador_de_adiamentos_sobe() {
    let clock = SiteClock::new();
    assert_eq!(clock.deferred_count(), 0);
    clock.count_deferred();
    clock.count_deferred();
    assert_eq!(clock.deferred_count(), 2);
}

// ─── A régua do Retry-After ──────────────────────────────────────────────────

#[test]
fn retry_after_com_default_teto_e_piso() {
    // Sem header: o default de 60 s (nunca 0 — martelada).
    assert_eq!(retry_after_capped(None), DEFERRED_DEFAULT_MS);
    // Header honesto é honrado.
    assert_eq!(retry_after_capped(Some(30_000)), 30_000);
    // Piso: `Retry-After: 0` não vira martelada.
    assert_eq!(retry_after_capped(Some(0)), 1_000);
    // Teto: o MESMO do Mico — header mentiroso de horas não para o site.
    assert_eq!(
        retry_after_capped(Some(86_400_000)),
        crate::mico_net::throttle::DEFAULT_MAX_RETRY_AFTER_MS
    );
}

#[test]
fn retry_after_lido_do_header() {
    let mut headers = HashMap::new();
    assert_eq!(
        retry_after_ms_from_headers(&headers),
        None,
        "sem header, sem prazo — quem chama aplica o default"
    );
    // Chave minúscula (o reqwest entrega assim).
    headers.insert("retry-after".to_string(), "42".to_string());
    assert_eq!(retry_after_ms_from_headers(&headers), Some(42_000));
    // Case-insensitive: proxies reescrevem a capitalização.
    let mut maiuscula = HashMap::new();
    maiuscula.insert("Retry-After".to_string(), "7".to_string());
    assert_eq!(retry_after_ms_from_headers(&maiuscula), Some(7_000));
    // HTTP-date e lixo viram ausência — interpretar data com relógio local
    // é arriscar o prazo errado; o default é mais seguro.
    let mut data = HashMap::new();
    data.insert(
        "retry-after".to_string(),
        "Wed, 21 Oct 2026 07:28:00 GMT".to_string(),
    );
    assert_eq!(retry_after_ms_from_headers(&data), None);
}

// ─── O mapeamento do adiável ────────────────────────────────────────────────

#[test]
fn deferred_mapeado_do_erro_http() {
    // 429 com Retry-After de 3 s: adiável com o prazo HONRADO.
    let PageOutcome::Deferred {
        retry_after_ms,
        label,
    } = PageOutcome::from(fetch_error_of(429, Some(3_000)))
    else {
        panic!("429 tem de virar Deferred, não Failed");
    };
    assert_eq!(retry_after_ms, 3_000);
    assert_eq!(label, "http_429", "o rótulo exato é o contrato do store");
    // 503 sem header: o default de 60 s.
    let PageOutcome::Deferred { retry_after_ms, .. } = PageOutcome::from(fetch_error_of(503, None))
    else {
        panic!("503 também é adiável");
    };
    assert_eq!(retry_after_ms, DEFERRED_DEFAULT_MS);
    // Status comum continua falha com o rótulo histórico.
    assert!(matches!(
        PageOutcome::from(fetch_error_of(404, None)),
        PageOutcome::Failed(ref m) if m == "http_404"
    ));
    // A conversa para String (a que o page_engine_vaca usa com `?`) mantém
    // o rótulo — é o caminho textual que o from_work reconhece.
    assert_eq!(String::from(fetch_error_of(503, Some(9_000))), "http_503");
}

// ─── As réguas de retorno da linha ──────────────────────────────────────────

#[test]
fn from_deferred_produz_error_nao_terminal() {
    let row = linha("vacatorrent", 2);
    let agora = now_ms();
    let mark = MarkResult::from_deferred(&row, "http_429", 60_000, 1, agora);
    assert_eq!(
        mark.status, "error",
        "status textual — é o que o painel conta"
    );
    assert_eq!(
        mark.error, "http_429",
        "PREFIXO exato: o store não incrementa tries por ele (contrato)"
    );
    assert!(
        mark.next_at > agora,
        "next_at > 0 → o store grava `pending` (NÃO-terminal)"
    );
    assert_eq!(mark.next_at, agora + 60_000);
    assert_eq!(mark.releases, 0, "não há releases num adiamento");
    assert_eq!(
        mark.request_cost, 1,
        "a requisição 429 aconteceu — o teto por hora a cobra"
    );
}

#[test]
fn from_work_mantem_adiavel_nao_terminal_mesmo_esgotado() {
    // Caminho do SUB-FETCH do Vaca (o page_engine_vaca fala String): o 429
    // chega aqui como erro comum — e NUNCA pode virar terminal.
    let row = linha("vacatorrent", 150);
    let work = error_work(&row, "http_429");
    let mark = MarkResult::from_work(&row, &work, false, &cfg(3), now_ms());
    assert_eq!(mark.status, "error");
    assert_eq!(mark.error, "http_429");
    assert!(
        mark.next_at > now_ms(),
        "adiável esgotado não terminal — a linha volta pending"
    );
}

#[test]
fn from_work_erro_comum_esgotado_continua_terminal() {
    let row = linha("bludv", 2); // max_tries 3 → esta é a última tentativa
    let work = error_work(&row, "boom");
    let mark = MarkResult::from_work(&row, &work, false, &cfg(3), now_ms());
    assert_eq!(
        mark.next_at, 0,
        "esgotou sem ser adiável: terminal, como sempre foi"
    );
}

#[test]
fn recuo_longo_apos_vinte_tentativas() {
    let agora = now_ms();
    // tries = 19 → esta é a tentativa 20, a primeira PERSISTENTE.
    let row = linha("bludv", MAX_PERSISTENT_TRIES - 1);
    let work = error_work(&row, "boom");
    let mark = MarkResult::from_work(&row, &work, false, &cfg(100), agora);
    assert_eq!(
        mark.next_at,
        agora + PERSISTENT_BACKOFF_MS,
        "persistente dorme 7 dias — para de martelar sem apagar a linha"
    );
}

#[test]
fn antes_do_recuo_longo_vale_backoff_normal() {
    let agora = now_ms();
    let row = linha("bludv", MAX_PERSISTENT_TRIES - 2); // tentativa 19 < 20
    let work = error_work(&row, "boom");
    let mark = MarkResult::from_work(&row, &work, false, &cfg(100), agora);
    let esperado = agora + error_backoff_ms(60_000, 21_600_000, MAX_PERSISTENT_TRIES - 1) as i64;
    assert_eq!(
        mark.next_at, esperado,
        "antes do limiar, o backoff de sempre (cap 6 h da config default)"
    );
}
