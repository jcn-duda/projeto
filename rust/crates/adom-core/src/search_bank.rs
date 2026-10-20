//! Porte da via do banco de magnets — `pickSource`
//! (`src/providers/magnet-bank-fallback.ts`), `isRecentRelease` e
//! `instantWindow` (`src/providers/magnet-bank-instant.ts`).
//!
//! Goldens: `rust/golden/magnet-bank-source.jsonl` (12 casos) e
//! `rust/golden/magnet-bank-instant.jsonl` (27 casos), gerados por
//! `node scripts/golden/dump-magnet-bank-{source,instant}.mjs` contra o TS REAL
//! do `dist`; teste em `tests/search_bank_golden.rs`.
//!
//! DECISÃO DE `Date.parse`: o TS aceita muito mais que ISO-8601 (RFC 2822,
//! "13/01/2027"…), e datetime SEM offset é interpretado no FUSO do processo —
//! um golden dessas formas ficaria dependente da máquina que o gera. Este porte
//! aceita o subconjunto que Cinemeta/TMDB mandam de verdade e que é
//! determinístico: `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (UTC) e
//! `YYYY-MM-DDTHH:MM[:SS[.fff]]` COM offset (`Z`/`±HH:MM`/`±HHMM`). Formato
//! fora disso, datetime sem offset e dia impossível ("2027-02-30") viram `0`
//! (falsy), como o `NaN` do TS. O corpus não contém caso que dependa do fuso —
//! o limite está aqui documentado, não escondido.
//!
//! Ligado na ponte (`instantWindow`/`isRecentRelease`/`pickSource`): a casca TS
//! lê `config.magnetBank.*`, as linhas do SQLite e o relógio e passa os valores;
//! o núcleo continua puro.

use std::collections::HashSet;

/// Um dia em milissegundos.
const DAY_MS: i64 = 86_400_000;
/// Janela de "lançamento recente" para filme e para episódio.
const FRESH_MOVIE_MS: i64 = 30 * DAY_MS;
const FRESH_EPISODE_MS: i64 = 14 * DAY_MS;

/// Linha de fonte do acervo, na forma que o `pickSource` consome.
#[derive(Clone, Copy, Debug)]
pub struct SourceRow<'a> {
    pub indexer: &'a str,
    pub last_seen: i64,
}

/// Normalização do TS (`nIndexer`): `String(value || '').trim().toLowerCase()`.
///
/// O conjunto `failed` do TS NÃO é normalizado — só o indexer da fonte. O
/// golden prende isso: `failed: ["NERD"]` não casa com a fonte `"nerd"`.
fn normalize_indexer(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Fonte elegível: indexer falho; com `all_failed`, qualquer source do banco.
/// Devolve o ÍNDICE da escolhida — o `reduce` do TS fica com a PRIMEIRA no
/// empate (`current.lastSeen > best.lastSeen` é estrito).
pub fn pick_source(
    sources: &[SourceRow<'_>],
    failed: &HashSet<String>,
    all_failed: bool,
) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (index, source) in sources.iter().enumerate() {
        if !all_failed && !failed.contains(&normalize_indexer(source.indexer)) {
            continue;
        }
        best = match best {
            None => Some(index),
            Some(current) => {
                if source.last_seen > sources[current].last_seen {
                    Some(index)
                } else {
                    Some(current)
                }
            }
        };
    }
    best
}

/// Dias desde a epoch (algoritmo de Hinnant) — válido para o range do Calendário
/// Gregoriano proleático, muito além de datas de release.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// O inverso: (ano, mês, dia) a partir dos dias desde a epoch.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => 0,
    }
}

/// `Date.parse` do TS no subconjunto determinístico (ver o cabeçalho). `0` é o
/// `NaN` do TS: data ausente ou fora do subconjunto.
fn js_date_parse_ms(text: &str) -> i64 {
    parse_date_ms(text).unwrap_or(0)
}

/// `Date.parse` do TS no subconjunto determinístico, com `None` para inválida —
/// o dia da epoch (`1970-01-01`) É uma data válida e não pode colidir com o
/// sentinela `0`.
///
/// Público porque a data de estreia do episódio (`meta.episodeAired`) chega
/// como TEXTO do Cinemeta e a guarda de pré-air do build precisa de ms: o
/// orquestrador usa ESTE parser em vez de um `Date.parse` próprio (ver
/// `adom-search::orchestrator::meta`). O subconjunto aceito é o documentado no
/// cabeçalho do módulo.
pub fn parse_date_ms(text: &str) -> Option<i64> {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    // "YYYY" | "YYYY-MM" | "YYYY-MM-DD" — sempre UTC no JS.
    let parts: Vec<&str> = text.split('-').collect();
    let (year, month, day) = match parts.as_slice() {
        [y] if y.len() == 4 && digits(y) => (y.parse::<i64>().ok()?, 1, 1),
        [y, m] if y.len() == 4 && digits(y) && m.len() == 2 && digits(m) => {
            (y.parse::<i64>().ok()?, m.parse::<i64>().ok()?, 1)
        }
        [y, m, d]
            if y.len() == 4
                && digits(y)
                && m.len() == 2
                && digits(m)
                && d.len() == 2
                && digits(d) =>
        {
            (
                y.parse::<i64>().ok()?,
                m.parse::<i64>().ok()?,
                d.parse::<i64>().ok()?,
            )
        }
        _ => return parse_datetime_with_time(text),
    };
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some(days_from_civil(year, month, day) * DAY_MS)
}

/// `YYYY-MM-DDTHH:MM[:SS[.fff]]` com offset OBRIGATÓRIO (`Z`/`±HH:MM`/`±HHMM`).
/// Sem offset o JS usa o fuso do processo — fora do porte, por decisão.
fn parse_datetime_with_time(text: &str) -> Option<i64> {
    let (date_part, time_part) = text.split_once('T')?;
    let date = parse_date_ms(date_part)?;
    // Separa o offset do fim antes de validar o relógio.
    let (clock, offset_ms) = if let Some(stripped) = time_part.strip_suffix('Z') {
        (stripped, 0)
    } else if let Some(sign_pos) = time_part.rfind(['+', '-']) {
        let (clock, offset) = time_part.split_at(sign_pos);
        let offset = parse_utc_offset(offset)?;
        (clock, offset)
    } else {
        return None; // sem offset: dependente de fuso, deliberadamente rejeitado
    };
    let clock_parts: Vec<&str> = clock.split(':').collect();
    let (hour, minute, second, milli) = match clock_parts.as_slice() {
        [h, m] if digits2(h) && digits2(m) => (num2(h), num2(m), 0, 0),
        // Inteiros primeiro: `digits2` rejeita o ponto, então "00.5" cai no
        // braço de baixo — e "01" não morre no `?` de lá.
        [h, m, s] if digits2(h) && digits2(m) && digits2(s) => (num2(h), num2(m), num2(s), 0),
        [h, m, s_ms] if digits2(h) && digits2(m) => {
            let (s, frac) = s_ms.split_once('.')?;
            if !digits2(s)
                || frac.is_empty()
                || frac.len() > 3
                || !frac.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            // Subconjunto documentado: até 3 dígitos. ".5" → 500; ".1234" fica
            // FORA do porte (o JS truncaria para 123) e vira `0`/None.
            let scaled: i64 = frac.parse().unwrap_or(0);
            let milli = scaled * 10_i64.pow(3 - frac.len() as u32);
            (num2(h), num2(m), num2(s), milli)
        }
        _ => return None,
    };
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some(date + hour * 3_600_000 + minute * 60_000 + second * 1_000 + milli - offset_ms)
}

fn digits2(s: &str) -> bool {
    s.len() == 2 && s.bytes().all(|b| b.is_ascii_digit())
}

fn num2(s: &str) -> i64 {
    s.parse().unwrap_or(99)
}

/// `Z` | `±HH:MM` | `±HHMM` → milissegundos; qualquer outra forma é `None`.
fn parse_utc_offset(text: &str) -> Option<i64> {
    let (sign, rest) = match text.split_at(1) {
        ("+", rest) => (1_i64, rest),
        ("-", rest) => (-1_i64, rest),
        _ => return None,
    };
    let (h, m) = match rest.split_once(':') {
        Some((h, m)) if digits2(h) && digits2(m) => (num2(h), num2(m)),
        None if rest.len() == 4 && rest.bytes().all(|b| b.is_ascii_digit()) => {
            (num2(&rest[..2]), num2(&rest[2..]))
        }
        _ => return None,
    };
    if h > 23 || m > 59 {
        return None;
    }
    Some(sign * (h * 3_600_000 + m * 60_000))
}

/// `String(value || '')` + `Date.parse` + `Number.isFinite` do TS.
fn as_time(value: &str) -> i64 {
    if value.is_empty() {
        return 0;
    }
    js_date_parse_ms(value)
}

/// Ano UTC de um instante (`new Date(now).getUTCFullYear()`).
fn utc_year(now: i64) -> i64 {
    civil_from_days(now.div_euclid(DAY_MS)).0
}

/// Sinais de catálogo da obra, já na forma `String(...)` do TS.
#[derive(Clone, Copy, Debug, Default)]
pub struct InstantMeta<'a> {
    /// `String(meta.year ?? '')` — pode vir com sufixo ("2024–").
    pub year: &'a str,
    /// Data de lançamento do filme (ISO), quando o metadado carrega.
    pub released: &'a str,
    /// Data de exibição do episódio (ISO).
    pub first_aired: &'a str,
}

/// Lançamento recente: dentro de 30 dias (filme) ou 14 (episódio), ou ano de
/// catálogo corrente. Sem data, o ano é o sinal grosseiro — conservador:
/// encurta a janela, nunca a estende.
pub fn is_recent_release(meta: &InstantMeta<'_>, now: i64) -> bool {
    let released = as_time(meta.released);
    if released != 0 && now >= released && now - released <= FRESH_MOVIE_MS {
        return true;
    }
    let first_aired = as_time(meta.first_aired);
    if first_aired != 0 && now >= first_aired && now - first_aired <= FRESH_EPISODE_MS {
        return true;
    }
    // `Number(String(meta.year ?? '').slice(0, 4))`: os 4 primeiros caracteres
    // ("2024–" → 2024). Vazio/lixo cai no falso, igual ao `isFinite` do TS.
    let head: String = meta.year.chars().take(4).collect();
    match head.trim().parse::<f64>() {
        Ok(year) => year.is_finite() && year >= utc_year(now) as f64,
        Err(_) => false,
    }
}

/// Linha de obra do banco, na forma que a janela consome.
#[derive(Clone, Copy, Debug)]
pub struct WorkRow {
    /// `passed_filter=1` é coleta viva que passou pelo filtro de relevância.
    pub passed_filter: i64,
    pub last_seen: i64,
    pub first_seen: i64,
}

/// Janela adaptativa devolvida pela [`instant_window`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InstantWindow {
    pub window_ms: i64,
    /// Maior `last_seen` de obra com `passed_filter=1` (0 = nunca houve coleta).
    pub last_collection: i64,
    /// Maior `first_seen` — quando o banco descobriu o torrent mais novo.
    pub newest: i64,
    /// `last_collection − newest`: há quanto tempo não vem novidade.
    pub stability: i64,
    /// Lançamento recente: a janela sofreu o teto curto.
    pub fresh: bool,
}

/// `clamp(estabilidade ÷ 2, min, max)`, com o lançamento recente no teto curto:
/// uma estreia pode ganhar release a qualquer hora. Config por parâmetro — o
/// núcleo não conhece `.env`.
///
/// CUIDADO com o golden: o TS lê `config.magnetBank.*` DENTRO da função, então
/// o golden prende o comportamento sob os DEFAULTS (`min = max = 7 dias`,
/// `freshMax = 2h`) — com esse config o clamp adaptativo não se manifesta; quem
/// mudar o default de lá regenera o golden junto.
pub fn instant_window(
    works: &[Option<WorkRow>],
    meta: &InstantMeta<'_>,
    now: i64,
    min_ms: i64,
    max_ms: i64,
    fresh_max_ms: i64,
) -> InstantWindow {
    let mut last_collection: i64 = 0;
    let mut newest: i64 = 0;
    for work in works.iter().flatten() {
        if work.passed_filter == 1 && work.last_seen > last_collection {
            last_collection = work.last_seen;
        }
        if work.first_seen > newest {
            newest = work.first_seen;
        }
    }
    let stability = (last_collection - newest).max(0);
    let min = min_ms.max(1);
    let max = max_ms.max(min);
    let mut window_ms = (stability / 2).max(min).min(max);
    let fresh = is_recent_release(meta, now);
    if fresh {
        window_ms = window_ms.min(fresh_max_ms.max(1));
    }
    InstantWindow {
        window_ms,
        last_collection,
        newest,
        stability,
        fresh,
    }
}

#[cfg(test)]
#[path = "search_bank_tests.rs"]
mod tests;
