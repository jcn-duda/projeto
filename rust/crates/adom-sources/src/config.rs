//! Configuração dos clientes — os mesmos knobs do oráculo TS
//! (`src/config/providers.ts`), com `base_url` injetável para o servidor de
//! teste. `TTL` é injetável aqui e o store também (ver [`crate::MetaStore`]).

/// `User-Agent` padrão do oráculo (`cinemeta.ts`).
pub const DEFAULT_USER_AGENT: &str = "stremio-adom/1.0";

/// Base pública do Cinemeta (API do ecossistema Stremio).
pub const CINEMETA_BASE: &str = "https://v3-cinemeta.strem.io";
/// Base pública do TMDB.
pub const TMDB_BASE: &str = "https://api.themoviedb.org/3";

/// Configuração do cliente Cinemeta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CinemetaConfig {
    /// Base da API. Injetável para o servidor de teste.
    pub base_url: String,
    /// Teto de UMA requisição (`CINEMETA_TIMEOUT_MS`).
    pub request_timeout_ms: u64,
    /// TTL do meta (7 dias no TS).
    pub cache_ttl_secs: u64,
    /// Miss autoritativo (404/corpo sem `meta`) — `CINEMETA_MISS_TTL`.
    pub miss_ttl_secs: u64,
    /// Miss transitório (rede/429/5xx) — `CINEMETA_TRANSIENT_MISS_TTL`.
    pub transient_miss_ttl_secs: u64,
}

impl Default for CinemetaConfig {
    fn default() -> Self {
        Self {
            base_url: CINEMETA_BASE.to_string(),
            request_timeout_ms: 2_500,
            cache_ttl_secs: 86_400,
            miss_ttl_secs: 300,
            transient_miss_ttl_secs: 30,
        }
    }
}

/// Configuração do cliente TMDB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmdbConfig {
    /// Base da API (`https://api.themoviedb.org/3`). Injetável no teste.
    pub base_url: String,
    /// `TMDB_API_KEY`. Vazio desliga o cliente (fail-open, como no TS).
    pub api_key: String,
    /// Teto de UMA requisição (`TMDB_TIMEOUT_MS`).
    pub request_timeout_ms: u64,
    /// TTL longo das consultas completas (`TMDB_CACHE_TTL`, 7 dias).
    pub cache_ttl_secs: u64,
    /// Miss autoritativo (`TMDB_MISS_TTL`).
    pub miss_ttl_secs: u64,
    /// Miss transitório (`TMDB_TRANSIENT_MISS_TTL`).
    pub transient_miss_ttl_secs: u64,
    /// Teto próprio da coleção e da data doméstica
    /// (`TMDB_COLLECTION_TIMEOUT_MS`), sempre `min(prazo do caller, now+teto)`.
    pub collection_timeout_ms: u64,
    /// TTL da data doméstica (`SEARCH_PRE_HOME_RELEASE_TTL`).
    pub home_release_ttl_secs: u64,
    /// Kill-switch do corte doméstico (`SEARCH_PRE_HOME_RELEASE_CUT`).
    pub pre_home_release_cut: bool,
}

impl Default for TmdbConfig {
    fn default() -> Self {
        Self {
            base_url: TMDB_BASE.to_string(),
            api_key: String::new(),
            request_timeout_ms: 5_000,
            cache_ttl_secs: 604_800,
            miss_ttl_secs: 300,
            transient_miss_ttl_secs: 30,
            collection_timeout_ms: 2_500,
            home_release_ttl_secs: 86_400,
            pre_home_release_cut: true,
        }
    }
}

impl TmdbConfig {
    /// Sem chave não há consulta (e o chamador segue sem metadados).
    pub fn has_api_key(&self) -> bool {
        !self.api_key.trim().is_empty()
    }

    /// `enRetryTtl` do TS: `max(1, min(cacheTtl, transientMissTtl))`. O piso de
    /// 1s cobre o operador que zerou o TTL transitório — sem ele a entrada nem
    /// seria gravada e a API voltaria a ser martelada a cada busca.
    pub fn retry_ttl_secs(&self) -> u64 {
        self.cache_ttl_secs.min(self.transient_miss_ttl_secs).max(1)
    }
}

/// Configuração do par de clientes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourcesConfig {
    /// `User-Agent` de TODAS as requisições (Cinemeta usa no TS; o TMDB ganha o
    /// mesmo em vez do UA do reqwest).
    pub user_agent: String,
    pub cinemeta: CinemetaConfig,
    pub tmdb: TmdbConfig,
}

impl Default for SourcesConfig {
    fn default() -> Self {
        Self {
            user_agent: DEFAULT_USER_AGENT.to_string(),
            cinemeta: CinemetaConfig::default(),
            tmdb: TmdbConfig::default(),
        }
    }
}

impl SourcesConfig {
    /// Config de produção lida do ambiente — as MESMAS envs do Node
    /// (`src/config/providers.ts`), para o caminho nativo (`META_RUST`) não
    /// divergir do oráculo. `TMDB_API_KEY` vazio desliga o TMDB (fail-open, como
    /// no TS). Números inválidos caem no default, nunca em zero acidental.
    pub fn from_env() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Variante pura (testável sem mexer no env do processo).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let get = |key: &str| lookup(key).map(|raw| raw.trim().to_string());
        let num = |key: &str, default: u64| {
            get(key)
                .and_then(|raw| raw.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value as u64)
                .unwrap_or(default)
        };
        let cinemeta = CinemetaConfig {
            base_url: CINEMETA_BASE.to_string(),
            request_timeout_ms: num("CINEMETA_TIMEOUT_MS", 2_500),
            cache_ttl_secs: 86_400,
            miss_ttl_secs: num("CINEMETA_MISS_TTL", 300),
            transient_miss_ttl_secs: num("CINEMETA_TRANSIENT_MISS_TTL", 30),
        };
        let tmdb = TmdbConfig {
            base_url: TMDB_BASE.to_string(),
            api_key: get("TMDB_API_KEY").unwrap_or_default(),
            request_timeout_ms: num("TMDB_TIMEOUT_MS", 5_000),
            cache_ttl_secs: num("TMDB_CACHE_TTL", 604_800),
            miss_ttl_secs: num("TMDB_MISS_TTL", 300),
            transient_miss_ttl_secs: num("TMDB_TRANSIENT_MISS_TTL", 30),
            collection_timeout_ms: num("TMDB_COLLECTION_TIMEOUT_MS", 2_500),
            home_release_ttl_secs: num("SEARCH_PRE_HOME_RELEASE_TTL", 86_400),
            // `String(env || 'true') === 'true'`: só o literal "true" liga; env
            // ausente/vazia mantém o default do Node (ligado).
            pre_home_release_cut: get("SEARCH_PRE_HOME_RELEASE_CUT")
                .map(|raw| raw == "true")
                .unwrap_or(true),
        };
        Self {
            user_agent: DEFAULT_USER_AGENT.to_string(),
            cinemeta,
            tmdb,
        }
    }
}
