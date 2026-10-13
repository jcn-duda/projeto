//! Política de pausa automática do motor de raspagem (plano "Raspagem total", Fase 3).
//! Funções e estado puros, sem rede e sem armazenamento.
//!
//! Duas pausas automáticas, ambas conservadoras:
//!
//! - STREAK DE ERROS do site: 403/429/5xx, `blocked_host` e desafio do Cloudflare provam
//!   que o SITE está fora/bloqueando. N erros seguidos nessa classe pausam o site.
//!   Timeout, DNS e quebra de parse de uma única página NÃO pausam.
//!
//! - CANÁRIO DE LAYOUT: N páginas seguidas que antes publicavam torrent e agora respondem
//!   sem botão nenhum pausam com "layout mudou?". O sinal "antes publicava" é mantido
//!   pelo canário por URL (última visita que validou torrents), com limite de memória.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;

/// Teto padrão da memória do canário (URLs): ~50k números.
pub const PRIOR_MAX: usize = 50_000;

static SITE_LEVEL_ERROR_RE: OnceLock<Regex> = OnceLock::new();

/// O texto do erro pertence à classe "site fora/bloqueado"?
/// Casa status HTTP (403/429/5xx), host bloqueado pela segurança do resolver (`blocked_host:...`)
/// e o desafio do Cloudflare.
pub fn is_site_level_error(text: &str) -> bool {
    let re = SITE_LEVEL_ERROR_RE.get_or_init(|| {
        Regex::new(r"(?i)(?:(?-u:\b)403(?-u:\b)|(?-u:\b)429(?-u:\b)|(?-u:\b)5\d{2}(?-u:\b)|blocked_host|challenge|cloudflare|just a moment)").unwrap()
    });
    re.is_match(text)
}

fn days_from_civil(y: i64, m: u64, d: u64) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + (doe as i64) - 719468
}

static ISO_DATE_RE: OnceLock<Regex> = OnceLock::new();

/// Tenta interpretar uma string de data no formato ISO-8601 e devolve unix timestamp em milissegundos.
fn parse_iso_timestamp(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let re = ISO_DATE_RE.get_or_init(|| {
        Regex::new(r"^(?i)(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(?:Z|([+-]\d{2})(?::?(\d{2}))?)?)?$").unwrap()
    });
    let caps = re.captures(s)?;
    let year: i64 = caps.get(1)?.as_str().parse().ok()?;
    let month: u64 = caps.get(2)?.as_str().parse().ok()?;
    let day: u64 = caps.get(3)?.as_str().parse().ok()?;

    if year < 1000 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let hour: i64 = caps.get(4).map_or(Ok(0), |m| m.as_str().parse()).ok()?;
    let minute: i64 = caps.get(5).map_or(Ok(0), |m| m.as_str().parse()).ok()?;
    let second: i64 = caps.get(6).map_or(Ok(0), |m| m.as_str().parse()).ok()?;

    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) || !(0..=60).contains(&second) {
        return None;
    }

    let ms: i64 = if let Some(m) = caps.get(7) {
        let frac_str = m.as_str();
        if frac_str.len() >= 3 {
            frac_str[..3].parse().ok()?
        } else if frac_str.len() == 2 {
            frac_str.parse::<i64>().ok()? * 10
        } else if frac_str.len() == 1 {
            frac_str.parse::<i64>().ok()? * 100
        } else {
            0
        }
    } else {
        0
    };

    let offset_seconds: i64 = if let Some(m) = caps.get(8) {
        let tz_h: i64 = m.as_str().parse().ok()?;
        let tz_m: i64 = caps.get(9).map_or(Ok(0), |m| m.as_str().parse()).ok()?;
        if !(0..=59).contains(&tz_m) {
            return None;
        }
        if tz_h >= 0 {
            tz_h * 3600 + tz_m * 60
        } else {
            tz_h * 3600 - tz_m * 60
        }
    } else {
        0
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86400 + hour * 3600 + minute * 60 + second - offset_seconds;
    Some(seconds * 1000 + ms)
}

/// Maior lastmod (ISO) da leva descoberta; `""` quando nenhum é legível.
/// Compara por parse de timestamp (ISO 8601). Em caso de datas inválidas misturadas,
/// mantém a primeira string não vazia ou o melhor timestamp válido se houver.
pub fn max_lastmod<S: AsRef<str>>(urls: &[S]) -> String {
    let mut best: Option<&str> = None;
    let mut best_time: Option<i64> = None;

    for entry in urls {
        let s = entry.as_ref();
        if s.is_empty() {
            continue;
        }
        if let Some(time) = parse_iso_timestamp(s) {
            match best_time {
                Some(current_best) => {
                    if time > current_best {
                        best_time = Some(time);
                        best = Some(s);
                    }
                }
                None => {
                    best_time = Some(time);
                    best = Some(s);
                }
            }
        } else if best_time.is_none() && best.is_none() {
            best = Some(s);
        }
    }

    best.unwrap_or("").to_string()
}

/// Motivo de pausa automática (a pausa manual é configurada via `set_paused`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutoPauseReason {
    #[serde(rename = "error-streak")]
    ErrorStreak,
    #[serde(rename = "layout")]
    Layout,
}

impl AutoPauseReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ErrorStreak => "error-streak",
            Self::Layout => "layout",
        }
    }
}

impl std::fmt::Display for AutoPauseReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Limites para disparo de pausas automáticas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseLimits {
    /// Erros de site seguidos que pausam (`CRAWL_ERROR_PAUSE_STREAK`).
    pub error_pause_streak: usize,
    /// Páginas seguidas que perderam os botões (`CRAWL_LAYOUT_CANARY`).
    pub layout_canary: usize,
}

impl PauseLimits {
    pub fn new(error_pause_streak: usize, layout_canary: usize) -> Self {
        Self {
            error_pause_streak,
            layout_canary,
        }
    }
}

impl Default for PauseLimits {
    fn default() -> Self {
        Self {
            error_pause_streak: 5,
            layout_canary: 10,
        }
    }
}

/// Tipo do desfecho de processamento de uma página.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PageOutcomeKind {
    Done,
    #[serde(rename = "no-torrent")]
    NoTorrent,
    #[serde(rename = "no-work")]
    NoWork,
    Error,
    Simulated,
    Partial,
}

impl PageOutcomeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::NoTorrent => "no-torrent",
            Self::NoWork => "no-work",
            Self::Error => "error",
            Self::Simulated => "simulated",
            Self::Partial => "partial",
        }
    }
}

impl std::fmt::Display for PageOutcomeKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Desfecho de uma página, na forma consumida pela política.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOutcomeSignal {
    pub kind: PageOutcomeKind,
    #[serde(default)]
    pub site_level_error: bool,
    #[serde(default)]
    pub releases: Option<usize>,
}

impl PageOutcomeSignal {
    pub fn new(kind: PageOutcomeKind, site_level_error: bool, releases: Option<usize>) -> Self {
        Self {
            kind,
            site_level_error,
            releases,
        }
    }

    pub fn done(releases: usize) -> Self {
        Self {
            kind: PageOutcomeKind::Done,
            site_level_error: false,
            releases: Some(releases),
        }
    }

    pub fn no_torrent() -> Self {
        Self {
            kind: PageOutcomeKind::NoTorrent,
            site_level_error: false,
            releases: None,
        }
    }

    pub fn no_work() -> Self {
        Self {
            kind: PageOutcomeKind::NoWork,
            site_level_error: false,
            releases: None,
        }
    }

    pub fn error(site_level_error: bool) -> Self {
        Self {
            kind: PageOutcomeKind::Error,
            site_level_error,
            releases: None,
        }
    }

    pub fn simulated(releases: usize) -> Self {
        Self {
            kind: PageOutcomeKind::Simulated,
            site_level_error: false,
            releases: Some(releases),
        }
    }

    pub fn partial(releases: usize) -> Self {
        Self {
            kind: PageOutcomeKind::Partial,
            site_level_error: false,
            releases: Some(releases),
        }
    }

    pub fn releases_count(&self) -> usize {
        self.releases.unwrap_or(0)
    }
}

/// Estado da pausa automática de um site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrawlPausePolicy {
    pub error_streak: usize,
    pub canary_streak: usize,
    pub prior_releases: HashMap<String, usize>,
    url_seq: HashMap<String, u64>,
    insertion_order: VecDeque<(String, u64)>,
    seq: u64,
    prior_max: usize,
}

impl Default for CrawlPausePolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl CrawlPausePolicy {
    pub fn new() -> Self {
        Self {
            error_streak: 0,
            canary_streak: 0,
            prior_releases: HashMap::new(),
            url_seq: HashMap::new(),
            insertion_order: VecDeque::new(),
            seq: 0,
            prior_max: PRIOR_MAX,
        }
    }

    /// Permite customizar o teto LRU do canário para testes.
    pub fn with_prior_max(mut self, max: usize) -> Self {
        self.prior_max = max;
        self
    }

    /// Altera o teto de memória do canário (para testes).
    pub fn set_prior_max_for_test(&mut self, max: usize) {
        self.prior_max = max;
        while self.prior_releases.len() > self.prior_max {
            if let Some((oldest_key, oldest_seq)) = self.insertion_order.pop_front() {
                if let Some(&current_seq) = self.url_seq.get(&oldest_key) {
                    if current_seq == oldest_seq {
                        self.prior_releases.remove(&oldest_key);
                        self.url_seq.remove(&oldest_key);
                    }
                }
            } else {
                break;
            }
        }
    }

    pub fn error_streak(&self) -> usize {
        self.error_streak
    }

    pub fn canary_streak(&self) -> usize {
        self.canary_streak
    }

    pub fn error_streak_count(&self) -> usize {
        self.error_streak
    }

    pub fn canary_streak_count(&self) -> usize {
        self.canary_streak
    }

    pub fn prior_releases(&self) -> &HashMap<String, usize> {
        &self.prior_releases
    }

    /// Registra o desfecho de uma página. Regras:
    /// - erro de site → incrementa `error_streak`; atinge o limite → `AutoPauseReason::ErrorStreak`;
    /// - erro comum (timeout/parse) → não conta e não zera o canário (neutro);
    /// - `done`/`no-work`/`simulated` provam que o layout respondeu → zera ambos os streaks;
    ///   alimenta memória do canário quando teve releases > 0;
    /// - `partial` provou trabalho em andamento → zera `error_streak`, alimenta memória se
    ///   teve releases > 0, neutra no canário;
    /// - `no-torrent` sem torrent prévio é página só-streaming: não afeta o canário, mas
    ///   zera o streak de erros;
    /// - `no-torrent` com torrent prévio é evento do canário: incrementa `canary_streak` e,
    ///   ao atingir `layout_canary`, pausa com `AutoPauseReason::Layout`.
    pub fn observe_page(
        &mut self,
        url: &str,
        signal: &PageOutcomeSignal,
        limits: &PauseLimits,
    ) -> Option<AutoPauseReason> {
        let key = url;
        if signal.kind == PageOutcomeKind::Error {
            if signal.site_level_error {
                self.error_streak += 1;
                if self.error_streak >= limits.error_pause_streak.max(1) {
                    return Some(AutoPauseReason::ErrorStreak);
                }
            }
            return None;
        }

        if (signal.kind == PageOutcomeKind::Done || signal.kind == PageOutcomeKind::Simulated)
            && signal.releases.unwrap_or(0) > 0
        {
            self.remember_prior(key, signal.releases.unwrap_or(0));
        }

        if signal.kind == PageOutcomeKind::Partial {
            self.error_streak = 0;
            if signal.releases.unwrap_or(0) > 0 {
                self.remember_prior(key, signal.releases.unwrap_or(0));
            }
            return None;
        }

        if signal.kind == PageOutcomeKind::Done
            || signal.kind == PageOutcomeKind::NoWork
            || signal.kind == PageOutcomeKind::Simulated
        {
            self.error_streak = 0;
            self.canary_streak = 0;
            return None;
        }

        // no-torrent
        self.error_streak = 0;
        let prior = self.prior_releases.get(key).copied().unwrap_or(0);
        if prior == 0 {
            return None;
        }
        self.canary_streak += 1;
        if self.canary_streak >= limits.layout_canary.max(1) {
            Some(AutoPauseReason::Layout)
        } else {
            None
        }
    }

    /// Falha da descoberta entra no mesmo streak de erros de site.
    pub fn observe_site_failure(
        &mut self,
        text: &str,
        limits: &PauseLimits,
    ) -> Option<AutoPauseReason> {
        if !is_site_level_error(text) {
            return None;
        }
        self.error_streak += 1;
        if self.error_streak >= limits.error_pause_streak.max(1) {
            Some(AutoPauseReason::ErrorStreak)
        } else {
            None
        }
    }

    /// Descoberta bem-sucedida prova que o site respondeu: zera o streak de erros.
    pub fn observe_site_success(&mut self) {
        self.error_streak = 0;
    }

    /// Limpa o estado da política.
    pub fn reset(&mut self) {
        self.error_streak = 0;
        self.canary_streak = 0;
        self.prior_releases.clear();
        self.url_seq.clear();
        self.insertion_order.clear();
        self.seq = 0;
    }

    /// Guarda na memória LRU do canário a quantidade de releases vista nesta URL.
    pub fn remember_prior(&mut self, url: &str, releases: usize) {
        let key = url.to_string();
        self.seq = self.seq.wrapping_add(1);
        self.url_seq.insert(key.clone(), self.seq);
        self.prior_releases.insert(key.clone(), releases);
        self.insertion_order.push_back((key, self.seq));

        while self.prior_releases.len() > self.prior_max {
            if let Some((oldest_key, oldest_seq)) = self.insertion_order.pop_front() {
                if let Some(&current_seq) = self.url_seq.get(&oldest_key) {
                    if current_seq == oldest_seq {
                        self.prior_releases.remove(&oldest_key);
                        self.url_seq.remove(&oldest_key);
                    }
                }
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
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

        // Somente inválidas: mantém a primeira string não vazia
        let invalid = vec!["not-a-date", "corrupt-2026"];
        assert_eq!(max_lastmod(&invalid), "not-a-date");

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
}
