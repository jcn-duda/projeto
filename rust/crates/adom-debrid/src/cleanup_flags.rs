//! Flag da limpeza (`DEBRID_AL_CLEANUP`), kill-switch e anti-reenchimento.
//!
//! As envs do `adrm` são as MESMAS do processo Node: os dois lados leem o mesmo
//! `.env`, então um rollback de uma linha desliga o filtro nativo junto.

/// Liga a limpeza nativa. Default do código OFF (o corte sobe ON):
/// `drop_ready`/`drop_uncached` são ignorados e nada é apagado.
pub const CLEANUP_ENV: &str = "DEBRID_AL_CLEANUP";
/// Kill-switch de uma linha: qualquer valor de liga (`on/1/true/yes`) suprime
/// o plano e a fila mesmo com `DEBRID_AL_CLEANUP=on`.
pub const KILL_ENV: &str = "DEBRID_AL_CLEANUP_KILL";
/// TTL do snapshot `knownBefore`, o mesmo do Node (`ALLDEBRID_PREEXISTING_TTL_MS`).
pub const PREEXISTING_TTL_ENV: &str = "ALLDEBRID_PREEXISTING_TTL_MS";
/// Caminho do `cache.db` do Node (proteção durável `adprot`/`adsub`).
pub const CACHE_DB_ENV: &str = "CACHE_DB_PATH";
/// Kill-switch do anti-reenchimento (`adrm`) — a MESMA env do Node
/// (`src/config/debrid.ts::reuploadBlock`, default `true`). Rust e Node leem o
/// mesmo `.env`: `DEBRID_REUPLOAD_BLOCK=false` desliga a marcação e o filtro de
/// upload nos DOIS lados, sem depender da versão do binário nativo.
pub const REUPLOAD_BLOCK_ENV: &str = "DEBRID_REUPLOAD_BLOCK";
/// TTL do `adrm` — a MESMA env do Node
/// (`alldebridReuploadBlockTtlMs`, default 3 dias). `0` desliga gravação E
/// leitura, também nos dois lados (rollback de uma linha no `.env`).
pub const REUPLOAD_TTL_ENV: &str = "ALLDEBRID_REUPLOAD_BLOCK_TTL_MS";

/// `3 * 24 * 3600 * 1000` do Node.
const DEFAULT_REUPLOAD_TTL_MS: f64 = 259_200_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CleanupMode {
    /// Default: read-only. Mesmo com os `drop_*` ligados, ninguém sai.
    #[default]
    Off,
    /// Habilita o plano; a execução ainda exige `holds_complete` + inventário.
    On,
}

impl CleanupMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "on" | "1" | "true" | "yes" | "rust" => Self::On,
            _ => Self::Off,
        }
    }

    pub fn from_env() -> Self {
        std::env::var(CLEANUP_ENV)
            .ok()
            .as_deref()
            .map(Self::parse)
            .unwrap_or_default()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::On => "on",
        }
    }

    pub fn is_on(self) -> bool {
        matches!(self, Self::On)
    }
}

pub fn kill_switch_on() -> bool {
    std::env::var(KILL_ENV)
        .map(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "on" | "1" | "true" | "yes"
            )
        })
        .unwrap_or(false)
}

pub fn env_truthy(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(raw) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "on" | "1" | "true" | "yes"
        ),
        Err(_) => default,
    }
}

/// `enabled()` do `alldebrid-reupload.ts`: o anti-reenchimento só existe com a
/// flag ligada **e** TTL > 0. As envs são as MESMAS do processo Node — os dois
/// lados leem o mesmo `.env`, então um rollback de uma linha desliga o filtro
/// nativo junto. Antes só o Node checava: `DEBRID_REUPLOAD_BLOCK=false` parava
/// de marcar e o Rust continuava tirando o hash do `/magnet/upload`.
pub fn reupload_block_enabled() -> bool {
    reupload_block_enabled_from(
        std::env::var(REUPLOAD_BLOCK_ENV).ok().as_deref(),
        std::env::var(REUPLOAD_TTL_ENV).ok().as_deref(),
    )
}

/// Regra pura (sem env global): usada pelos testes e pelo `enabled()`.
pub(crate) fn reupload_block_enabled_from(flag: Option<&str>, ttl: Option<&str>) -> bool {
    reupload_flag_from(flag) && reupload_ttl_ms_from(ttl) > 0.0
}

/// `String(process.env.DEBRID_REUPLOAD_BLOCK || 'true') === 'true'`.
pub(crate) fn reupload_flag_from(raw: Option<&str>) -> bool {
    match raw {
        None => true,
        Some("") => true,
        Some(text) => text == "true",
    }
}

/// `Math.max(0, num(process.env.ALLDEBRID_REUPLOAD_BLOCK_TTL_MS, 3d))`:
/// `Number('')` é 0 (desliga), valor não numérico cai no default e negativo
/// vira 0 pela comparação `> 0.0`.
pub(crate) fn reupload_ttl_ms_from(raw: Option<&str>) -> f64 {
    match raw {
        None => DEFAULT_REUPLOAD_TTL_MS,
        Some("") => 0.0,
        Some(text) => text
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .unwrap_or(DEFAULT_REUPLOAD_TTL_MS),
    }
}
