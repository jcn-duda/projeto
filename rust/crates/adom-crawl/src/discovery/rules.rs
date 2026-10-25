//! Regras PURAS da descoberta: fase/corte por kind, avanço de cursor e
//! `maxLastmod`. Porte de `crawl-cursor.ts` (`discoveryCuts`, `advanceCursors`,
//! `loadCursorsFromStore`) e de `crawl-pauses.ts::maxLastmod`.
//!
//! Duas decisões que o porte precisa manter, porque cada uma já custou uma
//! regressão medida:
//!
//! 1. **Cursor por KIND.** Filmes e séries têm sitemaps, falhas e ciclos
//!    independentes; um cursor único fazia a série ser refém do filme. O cursor
//!    de um kind só anda com a descoberta DAQUELE kind completa.
//! 2. **Lastmod ilegível ENTRA na fila.** Inventar data seria pior (o cursor
//!    andaria para o lado errado e a obra se perderia); o corte é economia, não
//!    correção — o `enqueue_discovered` é idempotente.
//!
//! Sem `chrono`: o crate não tem crate de data e o `Date.parse` que importa aqui
//! é só o ISO-8601 dos sitemaps. `days_from_civil` já mora no `br_core`.

use crate::br_core::http_date::days_from_civil;
use crate::discovery::types::{DiscoveredUrl, DiscoveryReport};
use crate::sitemap::CrawlPageKind;

/// Chave durável do cursor de filme (`CURSOR_STATE_KEY.movie` do TS).
pub const CURSOR_MOVIE_KEY: &str = "cursor:movie";
/// Chave durável do cursor de série (`CURSOR_STATE_KEY.tv_show` do TS).
pub const CURSOR_TV_KEY: &str = "cursor:tv_show";
/// Cursor LEGADO (Fase 6, único): migra para `cursor:movie` uma única vez.
pub const LEGACY_CURSOR_KEY: &str = "cursor";

/// Chave durável do cursor do kind (o `CURSOR_STATE_KEY` do TS).
pub fn cursor_key(kind: CrawlPageKind) -> &'static str {
    match kind {
        CrawlPageKind::Movie => CURSOR_MOVIE_KEY,
        CrawlPageKind::TvShow => CURSOR_TV_KEY,
    }
}

/// Fase da rodada. A coluna única da rodada registra o FILME, que domina o
/// progresso do painel: série sem cursor começa `initial` mesmo com filme
/// andando.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryPhase {
    Initial,
    Incremental,
}

/// Corte por kind de UMA rodada (`discoveryCuts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryCuts {
    pub phase: DiscoveryPhase,
    /// `None` = carga inicial daquele kind (cursor vazio NÃO vira fallback).
    pub movie: Option<String>,
    pub tv_show: Option<String>,
}

/// Normaliza um cursor lido do store: vazio é ausência, não valor.
fn cursor(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Fase e corte por kind. `None` explícito em um kind é corte "sem cursor"
/// (carga inicial dele) — herdar o cursor do outro kind esconderia acervo.
pub fn discovery_cuts(movie: Option<&str>, tv_show: Option<&str>) -> DiscoveryCuts {
    let movie = cursor(movie);
    let tv_show = cursor(tv_show);
    DiscoveryCuts {
        phase: if movie.is_some() {
            DiscoveryPhase::Incremental
        } else {
            DiscoveryPhase::Initial
        },
        movie,
        tv_show,
    }
}

/// O `lastmod` ainda não foi processado?
///
/// `true` quando não há cursor, quando qualquer um dos dois lados é ilegível
/// (obra não se perde por ruído de data) e quando `lastmod > since`.
pub fn should_keep(lastmod: &str, since: Option<&str>) -> bool {
    let Some(since) = since else { return true };
    let Some(floor) = parse_iso_ms(since) else {
        return true;
    };
    match parse_iso_ms(lastmod) {
        Some(t) => t > floor,
        None => true,
    }
}

/// Maior `lastmod` ISO das URLs de UM kind; `""` quando nenhum é legível.
///
/// Compara por instante e, com ilegíveis misturados, mantém o primeiro visto
/// (não inventa data nem deixa um lastmod corrompido regredir o cursor).
pub fn max_lastmod(urls: &[DiscoveredUrl], kind: CrawlPageKind) -> String {
    let mut best = String::new();
    let mut best_time = i64::MIN;
    for entry in urls.iter().filter(|u| u.kind == kind) {
        if entry.lastmod.is_empty() {
            continue;
        }
        match parse_iso_ms(&entry.lastmod) {
            Some(t) => {
                if t > best_time {
                    best_time = t;
                    best = entry.lastmod.clone();
                }
            }
            None => {
                if best.is_empty() {
                    best = entry.lastmod.clone();
                }
            }
        }
    }
    best
}

/// Cursor NOVO de um kind — `None` quando o cursor não deve andar.
///
/// Anda só com a descoberta DAQUELE kind completa e com algum `lastmod`
/// legível: sem URL do kind não há `max`, e avançar com parcial pularia o que
/// ficou num sitemap perdido.
pub fn next_cursor(report: &DiscoveryReport, kind: CrawlPageKind) -> Option<String> {
    let complete = match kind {
        CrawlPageKind::Movie => report.complete_movie,
        CrawlPageKind::TvShow => report.complete_tv_show,
    };
    if !complete {
        return None;
    }
    let max = max_lastmod(&report.urls, kind);
    (!max.is_empty()).then_some(max)
}

/// `Date.parse` do subconjunto que os sitemaps publicam: `YYYY-MM-DD` e
/// ISO-8601 com hora (`T`/espaço, segundos e fração opcionais, `Z` ou
/// `±HH:MM`). Fora dessa forma é `None` — o chamador trata como ilegível.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let s = text.trim();
    let b = s.as_bytes();
    if b.len() < 10 {
        return None;
    }
    // Os 10 primeiros bytes são ASCII (dígitos e hífen): o corte em `10` cai
    // numa fronteira de UTF-8 válida.
    let year = num(&b[0..4])?;
    if b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let month = num(&b[5..7])?;
    let day = num(&b[8..10])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms = days_from_civil(year, month, day).saturating_mul(86_400_000);
    if b.len() == 10 {
        return Some(ms);
    }
    if !matches!(b[10], b'T' | b't' | b' ') || b.len() < 16 || b[13] != b':' {
        return None;
    }
    let hour = num(&b[11..13])?;
    let minute = num(&b[14..16])?;
    if hour > 24 || minute > 59 {
        return None;
    }
    let mut idx = 16usize;
    let mut second = 0i64;
    let mut fraction_ms = 0i64;
    if idx < b.len() && b[idx] == b':' {
        if b.len() < idx + 3 {
            return None;
        }
        second = num(&b[idx + 1..idx + 3])?;
        if second > 60 {
            return None;
        }
        idx += 3;
        if idx < b.len() && b[idx] == b'.' {
            idx += 1;
            let start = idx;
            while idx < b.len() && b[idx].is_ascii_digit() {
                idx += 1;
            }
            if idx == start {
                return None;
            }
            // Só os três primeiros dígitos são milissegundos (`Date.parse`
            // trunca o resto); ignorar a fração mudaria o instante.
            let head = &b[start..(start + 3).min(idx)];
            fraction_ms = num(head)? * 10i64.pow(3 - head.len() as u32);
        }
    }
    let mut offset_ms = 0i64;
    if idx < b.len() {
        match b[idx] {
            b'Z' | b'z' => idx += 1,
            b'+' | b'-' => {
                let sign = if b[idx] == b'-' { -1 } else { 1 };
                idx += 1;
                if idx + 2 > b.len() {
                    return None;
                }
                let oh = num(&b[idx..idx + 2])?;
                idx += 2;
                let mut om = 0i64;
                if idx < b.len() && b[idx] == b':' {
                    if idx + 3 > b.len() {
                        return None;
                    }
                    om = num(&b[idx + 1..idx + 3])?;
                    idx += 3;
                }
                if oh > 23 || om > 59 {
                    return None;
                }
                offset_ms = sign * (oh * 3_600_000 + om * 60_000);
            }
            _ => return None,
        }
    }
    if idx != b.len() {
        return None;
    }
    ms = ms.saturating_add(hour * 3_600_000 + minute * 60_000 + second * 1_000 + fraction_ms);
    Some(ms.saturating_sub(offset_ms))
}

/// Dígitos ASCII em `bytes` → inteiro. Qualquer não-dígito invalida o campo.
fn num(bytes: &[u8]) -> Option<i64> {
    let mut out = 0i64;
    for b in bytes {
        if !b.is_ascii_digit() {
            return None;
        }
        out = out * 10 + i64::from(*b - b'0');
    }
    Some(out)
}

/// Rótulo legível da fase (log/painel).
impl DiscoveryPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::Incremental => "incremental",
        }
    }
}
