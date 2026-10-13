use serde::{Deserialize, Serialize};

/// Janela de espera para nova tentativa de adaptador com falha (60s).
pub const ADAPTER_RETRY_MS: i64 = 60_000;

/// Classe de trabalho devido (a ordem é a prioridade).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DueClass {
    Item,
    Discovery,
}

/// Contadores de estado das páginas de um site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SiteCounters {
    pub total: i64,
    pub pending: i64,
    pub error: i64,
    pub inflight: i64,
    pub partial: i64,
}

impl SiteCounters {
    pub fn new(total: i64, pending: i64, error: i64, inflight: i64, partial: i64) -> Self {
        Self {
            total,
            pending,
            error,
            inflight,
            partial,
        }
    }
}

/// Estado de execução do site relevante para a seleção.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SiteRuntime {
    pub id: String,
    pub paused: bool,
    pub auto_pause: bool,
    pub hour_pages: i64,
    pub last_active_at: i64,
    pub next_discover_at: i64,
    pub open_run_id: Option<i64>,
    /// Recuperação one-shot `simulated` pendente (religou o motor / dry-run desligou).
    pub need_simulated_recovery: bool,
    /// Recuperação one-shot de `inflight` órfã pendente (1ª passada após religar).
    pub need_inflight_recovery: bool,
    pub adapter_failed_at: i64,
    pub skip_reason: Option<String>,
}

impl SiteRuntime {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            ..Default::default()
        }
    }
}

pub use crate::policy::crawler_live::CrawlerSiteConfig;

/// Resumo do site para a decisão de seleção.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SiteCandidate {
    pub id: String,
    pub config: CrawlerSiteConfig,
    pub runtime: SiteRuntime,
    pub due: Option<DueClass>,
    pub skip_reason: Option<String>,
}

/// Resultado da seleção do próximo site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectResult {
    pub chosen: Option<SiteCandidate>,
    pub all: Vec<SiteCandidate>,
}

/// Consultas externas injetadas para a seleção (sem acesso direto ao banco).
pub trait SelectDeps {
    fn counters(&self, site_id: &str) -> SiteCounters;
    fn probe_open(&self, site_id: &str) -> bool;
    fn global_cap_hit(&self) -> bool;
    fn has_due(&self, site_id: &str, now: i64) -> Option<bool> {
        let _ = (site_id, now);
        None
    }
    fn is_own_pace(&self, site_id: &str) -> bool {
        is_own_pace(site_id)
    }
}

impl<D: SelectDeps + ?Sized> SelectDeps for &D {
    fn counters(&self, site_id: &str) -> SiteCounters {
        (**self).counters(site_id)
    }

    fn probe_open(&self, site_id: &str) -> bool {
        (**self).probe_open(site_id)
    }

    fn global_cap_hit(&self) -> bool {
        (**self).global_cap_hit()
    }

    fn has_due(&self, site_id: &str, now: i64) -> Option<bool> {
        (**self).has_due(site_id, now)
    }

    fn is_own_pace(&self, site_id: &str) -> bool {
        (**self).is_own_pace(site_id)
    }
}

/// Mock / builder ergonômico de `SelectDeps` para testes e injeção simples.
pub type HasDueFn = Box<dyn Fn(&str, i64) -> bool + Send + Sync>;
pub type IsOwnPaceFn = Box<dyn Fn(&str) -> bool + Send + Sync>;

pub struct MockSelectDeps {
    counters_fn: Box<dyn Fn(&str) -> SiteCounters + Send + Sync>,
    probe_open_fn: Box<dyn Fn(&str) -> bool + Send + Sync>,
    global_cap_hit_fn: Box<dyn Fn() -> bool + Send + Sync>,
    has_due_fn: Option<HasDueFn>,
    is_own_pace_fn: Option<IsOwnPaceFn>,
}

impl MockSelectDeps {
    pub fn new() -> Self {
        Self {
            counters_fn: Box::new(|_| SiteCounters::default()),
            probe_open_fn: Box::new(|_| true),
            global_cap_hit_fn: Box::new(|| false),
            has_due_fn: None,
            is_own_pace_fn: None,
        }
    }

    pub fn with_counters<F>(mut self, f: F) -> Self
    where
        F: Fn(&str) -> SiteCounters + Send + Sync + 'static,
    {
        self.counters_fn = Box::new(f);
        self
    }

    pub fn with_probe_open<F>(mut self, f: F) -> Self
    where
        F: Fn(&str) -> bool + Send + Sync + 'static,
    {
        self.probe_open_fn = Box::new(f);
        self
    }

    pub fn with_global_cap_hit<F>(mut self, f: F) -> Self
    where
        F: Fn() -> bool + Send + Sync + 'static,
    {
        self.global_cap_hit_fn = Box::new(f);
        self
    }

    pub fn with_has_due<F>(mut self, f: F) -> Self
    where
        F: Fn(&str, i64) -> bool + Send + Sync + 'static,
    {
        self.has_due_fn = Some(Box::new(f));
        self
    }

    pub fn with_is_own_pace<F>(mut self, f: F) -> Self
    where
        F: Fn(&str) -> bool + Send + Sync + 'static,
    {
        self.is_own_pace_fn = Some(Box::new(f));
        self
    }
}

impl Default for MockSelectDeps {
    fn default() -> Self {
        Self::new()
    }
}

impl SelectDeps for MockSelectDeps {
    fn counters(&self, site_id: &str) -> SiteCounters {
        (self.counters_fn)(site_id)
    }

    fn probe_open(&self, site_id: &str) -> bool {
        (self.probe_open_fn)(site_id)
    }

    fn global_cap_hit(&self) -> bool {
        (self.global_cap_hit_fn)()
    }

    fn has_due(&self, site_id: &str, now: i64) -> Option<bool> {
        self.has_due_fn.as_ref().map(|f| (f)(site_id, now))
    }

    fn is_own_pace(&self, site_id: &str) -> bool {
        if let Some(ref f) = self.is_own_pace_fn {
            (f)(site_id)
        } else {
            is_own_pace(site_id)
        }
    }
}

/// Verifica se o site possui ritmo próprio (Mico Leão Dublado).
pub fn is_own_pace(site_id: &str) -> bool {
    site_id == "mico"
}
