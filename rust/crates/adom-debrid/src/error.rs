//! Mesma taxonomia de `src/debrid/common.ts`: auth, quota, rate limit, 451,
//! NoVideo, EpisodePick e DubLie. O status HTTP decide antes do texto; no
//! texto, rate limit vence quota (o TS faz `isQuotaError` devolver false
//! quando o erro já é rate limit).

use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use adom_core::{EpisodeContext, EpisodeEvidence, PickCode};
use regex::Regex;

const NO_VIDEO: &str = "o torrent não contém nenhum arquivo de vídeo";
const EPISODE: &str = "não foi possível identificar o episódio dentro do pack";
const WORK: &str = "não foi possível identificar a obra dentro do pack";
const DUB: &str = "o torrent anunciado como dublado contém release em inglês";

static AUTH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)AUTH_(?:BAD_APIKEY|MISSING_APIKEY|BLOCKED|USER_BANNED)|authentication_failed|apikey is invalid|invalid (?:api )?(?:key|token)|unauthor[iz]|forbidden|bad token")
        .expect("regex de auth")
});

static QUOTA_RE: LazyLock<Regex> = LazyLock::new(|| {
    // `MAGNET_TOO_MANY` sem `_ACTIVE` é o teto real de 1000 magnets medido na
    // conta; a doc da AllDebrid só documenta os 30 ativos.
    Regex::new(
        r"(?i)MAGNET_TOO_MANY|magnets? limit reached|too many active|quota exceeded|limit reached",
    )
    .expect("regex de quota")
});

static RATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)rate_limit_reached|too many (?:api )?requests|slow down")
        .expect("regex de rate limit")
});

#[derive(Debug, Clone, PartialEq)]
pub enum DebridError {
    Auth(String),
    Quota(String),
    RateLimit {
        message: String,
        retry_after_ms: Option<u64>,
    },
    Blocked(String),
    NoVideo(String),
    /// Prova do `PickOutcome`: o `/debrid/link` antigo ignora os campos novos.
    // Prova em Box: sem ela o `Err` de todo `Result` do crate ficava enorme
    // (clippy::result_large_err) por causa de um caminho raro.
    EpisodePick {
        message: String,
        evidence: Option<Box<EpisodeEvidence>>,
        context: Option<Box<EpisodeContext>>,
    },
    DubLie {
        message: String,
        evidence: Option<Box<EpisodeEvidence>>,
        context: Option<Box<EpisodeContext>>,
    },
    WorkPick(String),
    Other(String),
}

impl DebridError {
    pub fn other(message: impl Into<String>) -> Self {
        Self::Other(message.into())
    }

    /// Mensagem do construtor TS. O texto que o usuário vê no `/resolve`
    /// é outro: fica em `resolve_effects`.
    pub fn from_pick(
        code: PickCode,
        evidence: Option<EpisodeEvidence>,
        context: Option<EpisodeContext>,
    ) -> Self {
        match code {
            PickCode::NoVideo => Self::NoVideo(NO_VIDEO.into()),
            PickCode::WorkPick => Self::WorkPick(WORK.into()),
            PickCode::EpisodePick => Self::EpisodePick {
                message: EPISODE.into(),
                evidence: evidence.map(Box::new),
                context: context.map(Box::new),
            },
            PickCode::DubLie => Self::DubLie {
                message: DUB.into(),
                evidence: evidence.map(Box::new),
                context: context.map(Box::new),
            },
        }
    }

    pub fn pick_parts(&self) -> (Option<&EpisodeEvidence>, Option<&EpisodeContext>) {
        match self {
            Self::EpisodePick {
                evidence, context, ..
            }
            | Self::DubLie {
                evidence, context, ..
            } => (evidence.as_deref(), context.as_deref()),
            _ => (None, None),
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Auth(m)
            | Self::Quota(m)
            | Self::Blocked(m)
            | Self::NoVideo(m)
            | Self::WorkPick(m)
            | Self::Other(m) => m,
            Self::RateLimit { message, .. } => message,
            Self::EpisodePick { message, .. } => message,
            Self::DubLie { message, .. } => message,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Auth(_) => "auth",
            Self::Quota(_) => "quota",
            Self::RateLimit { .. } => "rate_limit",
            Self::Blocked(_) => "blocked",
            Self::NoVideo(_) => "no_video",
            Self::EpisodePick { .. } => "episode_pick",
            Self::DubLie { .. } => "dub_lie",
            Self::WorkPick(_) => "work_pick",
            Self::Other(_) => "other",
        }
    }

    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            Self::RateLimit { retry_after_ms, .. } => *retry_after_ms,
            _ => None,
        }
    }

    /// Classifica a resposta HTTP do `json()` do TS: 401/403, 429 e 451
    /// nascem aqui; o resto olha o texto.
    pub fn from_http(status: u16, message: impl Into<String>, retry_after: Option<&str>) -> Self {
        let message = message.into();
        match status {
            401 | 403 => Self::Auth(message),
            429 => Self::RateLimit {
                message,
                retry_after_ms: retry_after.and_then(|value| parse_retry_after(value, now_ms())),
            },
            451 => Self::Blocked(message),
            _ => classify_message(&message),
        }
    }
}

impl std::fmt::Display for DebridError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message())
    }
}

impl std::error::Error for DebridError {}

pub fn classify_message(message: &str) -> DebridError {
    if RATE_RE.is_match(message) {
        return DebridError::RateLimit {
            message: message.to_string(),
            retry_after_ms: None,
        };
    }
    if QUOTA_RE.is_match(message) {
        return DebridError::Quota(message.to_string());
    }
    if AUTH_RE.is_match(message) {
        return DebridError::Auth(message.to_string());
    }
    DebridError::Other(message.to_string())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `Retry-After` em milissegundos: delta-seconds ou data HTTP.
pub fn parse_retry_after(value: &str, now: u64) -> Option<u64> {
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(seconds) = raw.parse::<f64>() {
        return Some((seconds.max(0.0) * 1000.0) as u64);
    }
    httpdate_ms(raw).map(|at| at.saturating_sub(now))
}

fn httpdate_ms(raw: &str) -> Option<u64> {
    // Subconjunto do Date.parse que o TS usa nos Retry-After que já vimos:
    // IMF-fix (`Sun, 06 Nov 1994 08:49:37 GMT`).
    let parsed = chrono_lite_imf(raw)?;
    Some(parsed)
}

fn chrono_lite_imf(raw: &str) -> Option<u64> {
    let bytes = raw.as_bytes();
    if bytes.len() < 29 || &raw[25..] != " GMT" && !raw.ends_with("GMT") {
        return None;
    }
    // "Sun, 06 Nov 1994 08:49:37 GMT"
    let day: u64 = raw.get(5..7)?.parse().ok()?;
    let month = match raw.get(8..11)? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i32 = raw.get(12..16)?.parse().ok()?;
    let hour: u64 = raw.get(17..19)?.parse().ok()?;
    let min: u64 = raw.get(20..22)?.parse().ok()?;
    let sec: u64 = raw.get(23..25)?.parse().ok()?;
    Some(civil_to_unix_ms(year, month, day, hour, min, sec))
}

fn civil_to_unix_ms(year: i32, month: u64, day: u64, hour: u64, min: u64, sec: u64) -> u64 {
    let mut y = year as i64;
    let mut m = month as i64;
    if m <= 2 {
        y -= 1;
        m += 12;
    }
    let era = y.div_euclid(400);
    let yoe = (y - era * 400) as u64;
    let doy = (153 * (m as u64 - 3) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe as i64 - 719468;
    let secs = days * 86400 + hour as i64 * 3600 + min as i64 * 60 + sec as i64;
    (secs.max(0) as u64).saturating_mul(1000)
}

#[cfg(test)]
mod tests {
    use adom_core::PickCode;

    use super::*;

    #[test]
    fn status_vence_o_texto() {
        let err = DebridError::from_http(401, "quota exceeded", None);
        assert_eq!(err.kind(), "auth");
        let limited = DebridError::from_http(429, "ok", Some("2"));
        assert_eq!(limited.kind(), "rate_limit");
        assert_eq!(limited.retry_after_ms(), Some(2000));
        assert_eq!(DebridError::from_http(451, "x", None).kind(), "blocked");
    }

    #[test]
    fn texto_rate_limit_vence_quota() {
        let err = classify_message("too many requests and quota exceeded");
        assert_eq!(err.kind(), "rate_limit");
    }

    #[test]
    fn texto_de_quota_e_auth() {
        assert_eq!(classify_message("MAGNET_TOO_MANY_ACTIVE").kind(), "quota");
        assert_eq!(
            classify_message("Magnets limit reached (MAGNET_TOO_MANY)").kind(),
            "quota"
        );
        assert_eq!(classify_message("AUTH_BAD_APIKEY").kind(), "auth");
        assert_eq!(classify_message("HTTP 500").kind(), "other");
    }

    #[test]
    fn retry_after_data_http() {
        let at = parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", 0).unwrap();
        assert!(at > 0);
    }

    #[test]
    fn kinds_de_play() {
        assert_eq!(DebridError::NoVideo("n".into()).kind(), "no_video");
        assert_eq!(
            DebridError::from_pick(PickCode::EpisodePick, None, None).kind(),
            "episode_pick"
        );
        assert_eq!(
            DebridError::from_pick(PickCode::DubLie, None, None).message(),
            "o torrent anunciado como dublado contém release em inglês"
        );
        assert_eq!(DebridError::WorkPick("w".into()).kind(), "work_pick");
    }
}
