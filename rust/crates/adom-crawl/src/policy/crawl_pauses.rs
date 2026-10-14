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

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

/// Teto padrão da memória do canário (URLs): ~50k números.
pub const PRIOR_MAX: usize = 50_000;

mod site_error;
pub use site_error::*;
mod timestamps;
pub use timestamps::*;

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
#[path = "crawl_pauses_tests.rs"]
mod tests;
