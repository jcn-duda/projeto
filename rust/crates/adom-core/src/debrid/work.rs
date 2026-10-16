//! Escolha por obra dentro de pack multi-filme. Sem casamento confiável a
//! escolha falha (`WorkPick`): o maior arquivo seria outro filme.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use fancy_regex::Regex;

use crate::normalize_title;

use super::text::{base_name, declared_years, is_extra, is_sample, is_video, js_size};
use super::{largest, outcome_file, outcome_work, DebridFile, PickOutcome, WorkHint};

const COVERAGE_MIN: f64 = 0.7;
const YEAR_TOLERANCE: i64 = 2;

fn year_token_re() -> &'static Regex {
    use std::sync::OnceLock;
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| Regex::new(r"(?:19|20)[0-9]{2}").expect("ano da dica"))
}

/// `String(year || '').match(/(?:19|20)\d{2}/)`. Zero e ausência não decidem.
fn clean_year(year: Option<i64>) -> i64 {
    let Some(year) = year.filter(|value| *value != 0) else {
        return 0;
    };
    let text = year.to_string();
    year_token_re()
        .find(&text)
        .expect("regex de ano executa")
        .and_then(|m| m.as_str().parse().ok())
        .unwrap_or(0)
}

fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Fração dos tokens significativos do nome que aparecem no caminho inteiro.
/// A pasta completa o arquivo ("star trek" na pasta, "sem fronteiras" no nome).
/// O ano continua só no basename — ver `declared_years`.
pub fn work_coverage(file_name: &str, name: &str) -> f64 {
    let normalized = normalize_title(name);
    let tokens: Vec<&str> = normalized
        .split(' ')
        .filter(|token| !token.is_empty())
        .collect();
    let long: Vec<&str> = tokens
        .iter()
        .copied()
        .filter(|token| js_len(token) > 2)
        .collect();
    let wanted: &[&str] = if long.is_empty() { &tokens } else { &long };
    if wanted.is_empty() {
        return 0.0;
    }
    let full = normalize_title(file_name);
    let got: Vec<&str> = full.split(' ').filter(|token| !token.is_empty()).collect();
    let mut hit = 0usize;
    for token in wanted {
        if got.contains(token) {
            hit += 1;
        }
    }
    hit as f64 / wanted.len() as f64
}

pub fn looks_multi_work_files(files: &[DebridFile]) -> bool {
    looks_multi(files.iter())
}

fn looks_multi<'a>(files: impl IntoIterator<Item = &'a DebridFile>) -> bool {
    let mains: Vec<&DebridFile> = files
        .into_iter()
        .filter(|file| is_video(&file.path) && !is_sample(&file.path) && !is_extra(&file.path))
        .collect();
    if mains.len() <= 1 {
        return false;
    }
    let mut years = Vec::new();
    for file in mains {
        // Vários anos no mesmo basename são ambíguos: só o primeiro entra, e
        // sozinho não transforma encodes do mesmo filme em pack.
        if let Some(&year) = declared_years(&file.path).first() {
            if !years.contains(&year) {
                years.push(year);
            }
        }
    }
    years.len() >= 2
}

/// Sem dica de ano não decide. Vídeo sem ano é ambíguo. Um vídeo dentro de ±2
/// salva o pack. Token de ano que pertence ao nome ("1917", "2049") não contradiz.
fn work_year_contradicts(pool: &[&DebridFile], year: Option<i64>, names: &[String]) -> bool {
    let clean = clean_year(year);
    if clean == 0 || pool.is_empty() {
        return false;
    }
    let declared: Vec<Vec<i64>> = pool.iter().map(|file| declared_years(&file.path)).collect();
    if declared.iter().any(|years| years.len() != 1) {
        return false;
    }
    let mut tokens = Vec::new();
    for name in names {
        for token in normalize_title(name).split(' ') {
            if !tokens.iter().any(|have: &String| have == token) {
                tokens.push(token.to_string());
            }
        }
    }
    if declared
        .iter()
        .any(|years| tokens.iter().any(|token| token == &years[0].to_string()))
    {
        return false;
    }
    declared
        .iter()
        .all(|years| (years[0] - clean).abs() > YEAR_TOLERANCE)
}

pub fn pick_work_file(
    files: &[DebridFile],
    names: &[String],
    year: Option<i64>,
) -> Option<DebridFile> {
    let refs: Vec<&DebridFile> = files.iter().collect();
    pick_work_refs(&refs, names, year).map(|file| DebridFile {
        path: file.path.clone(),
        size: js_size(file.size),
    })
}

fn pick_work_refs<'a>(
    files: &[&'a DebridFile],
    names: &[String],
    year: Option<i64>,
) -> Option<&'a DebridFile> {
    let mut scored = Vec::new();
    for file in files {
        let cov = if names.is_empty() {
            f64::NEG_INFINITY
        } else {
            names
                .iter()
                .map(|name| work_coverage(&file.path, name))
                .fold(f64::NEG_INFINITY, f64::max)
        };
        if cov >= COVERAGE_MIN {
            scored.push(*file);
        }
    }
    if scored.is_empty() {
        return None;
    }
    if scored.len() == 1 {
        return Some(scored[0]);
    }
    let clean = clean_year(year);
    if clean != 0 {
        // Regex de ano memoizada: o padrão só depende de `clean`, e compilar
        // `Regex` por chamada dominava o custo do `pick_work_file`.
        static YEAR_RE: OnceLock<Mutex<HashMap<i64, Regex>>> = OnceLock::new();
        let mut cache = YEAR_RE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .expect("cache de ano");
        let re = cache
            .entry(clean)
            .or_insert_with(|| {
                Regex::new(&format!(r"(?<![0-9]){clean}(?![0-9])")).expect("ano do arquivo")
            })
            .clone();
        drop(cache);
        let with_year: Vec<&DebridFile> = scored
            .iter()
            .copied()
            .filter(|file| {
                re.is_match(&base_name(&file.path))
                    .expect("regex de ano executa")
            })
            .collect();
        if with_year.len() == 1 {
            return Some(with_year[0]);
        }
        if with_year.len() > 1 {
            return Some(largest(&with_year));
        }
    }
    None
}

pub(super) fn pick_by_work(videos: &[&DebridFile], work: &WorkHint) -> PickOutcome {
    let mains: Vec<&DebridFile> = videos
        .iter()
        .copied()
        .filter(|file| !is_extra(&file.path))
        .collect();
    let pool: Vec<&DebridFile> = if mains.is_empty() {
        videos.to_vec()
    } else {
        mains
    };
    if work_year_contradicts(&pool, work.year, &work.names) {
        return outcome_work();
    }
    if pool.len() == 1 {
        return outcome_file(pool[0]);
    }
    if !work.pack && !looks_multi(pool.iter().copied()) {
        return outcome_file(largest(&pool));
    }
    if let Some(picked) = pick_work_refs(&pool, &work.names, work.year) {
        return outcome_file(picked);
    }
    outcome_work()
}
