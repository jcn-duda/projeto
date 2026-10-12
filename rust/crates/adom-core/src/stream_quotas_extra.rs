//! Porte das funções restantes de `stream-quotas.ts` e `stream-quotas-candidate.ts`.
//! `quality_from_title`, `stream_quality`, `is_season_pack_release`,
//! `limit_by_quality`, `limit_by_quality_and_indexer`, `select_quality_candidates`,
//! `limit_reserving_br`.

use std::collections::{HashMap, HashSet};
use regex::Regex;
use std::sync::OnceLock;

use crate::episode_parse::parse_title_season_episode;
use crate::js_text::js_trim;
use crate::stream_quotas::clamp_limit;

pub const UNKNOWN_QUALITY: &str = "sem resolução";
pub const QUALITY_KEYS: [&str; 6] = ["2160p", "1080p", "720p", "480p", "SD", UNKNOWN_QUALITY];

const TAG_BLOB_VOCAB: [&str; 11] = [
    "480p","540p","576p","720p","1080p","1440p","2160p","4k","uhd","sd","fullhd",
];

fn is_blob_tag(tag: &str) -> bool {
    let norm: String = tag.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    TAG_BLOB_VOCAB.contains(&norm.as_str())
}

#[derive(Debug, Clone)]
pub struct StreamRef {
    pub title: String,
    pub quality: Option<String>,
    pub indexer: Option<String>,
    pub is_br: bool,
    pub is_dubbed: bool,
    pub is_dub_claim: bool,
    pub is_lied: bool,
    pub is_season_pack: bool,
}

pub type QualityLimits = HashMap<String, f64>;

// ─── Classificação de qualidade ──────────────────────────────────────────────

fn tag_trail_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[,;]\s*[A-Za-z0-9][A-Za-z0-9+.\-]*\s*$").expect("regex"))
}

/// Remove blob de tags do fim do título (lista de qualidades separadas por vírgula).
fn strip_quality_tag_blob(title: &str) -> &str {
    if !title.contains(',') { return title; }
    let mut cut = title.len();
    let mut tags = 0u32;
    loop {
        let prefix = &title[..cut];
        let re = tag_trail_re();
        let Some(m) = re.find(prefix) else { break };
        let tag_text = prefix[m.start() + 1..m.end()].trim();
        if !is_blob_tag(tag_text) { break; }
        cut = m.start();
        tags += 1;
    }
    if tags < 2 { return title; }
    let before = title[..cut].trim_end();
    if let Some(start) = before.rfind(|c: char| c.is_ascii_whitespace()) {
        let head = &before[start + 1..];
        if !head.is_empty() && head.chars().next().map_or(false, |c| c.is_ascii_alphanumeric())
            && is_blob_tag(head) {
            return before[..start].trim_end();
        }
    } else if !before.is_empty()
        && before.chars().next().map_or(false, |c| c.is_ascii_alphanumeric())
        && is_blob_tag(before) {
        return "";
    }
    before
}

/// Classifica a qualidade a partir do título.
pub fn quality_from_title(title: &str) -> &str {
    let t = strip_quality_tag_blob(title).to_uppercase().replace('_', " ");
    // Insere espaço entre prefixo de fonte e resolução colada.
    let t = ["RIP","DL","WEB","HDTV"].iter().fold(t, |acc, pfx| {
        ["2160P","1080P","720P","480P"].iter().fold(acc, |a, res| {
            a.replace(&format!("{pfx}{res}"), &format!("{pfx} {res}"))
        })
    });
    if wb_contains(&t, "2160P") || wb_contains(&t, "4K") || wb_contains(&t, "UHD") { return "2160p"; }
    if wb_contains(&t, "1080P") { return "1080p"; }
    if wb_contains(&t, "720P") { return "720p"; }
    if wb_contains(&t, "480P") { return "480p"; }
    if wb_contains(&t,"576P") || wb_contains(&t,"540P") || wb_contains(&t,"360P")
        || wb_contains(&t,"240P") || wb_contains(&t,"SDTV") || wb_contains(&t,"DVD5")
        || wb_contains(&t,"DVD9") || t.contains("DVD-R") || t.contains("DVDR")
        || t.contains("DVD RIP") || t.contains("DVD SCR") || t.contains("VHS RIP")
        || wb_contains(&t,"TS") || wb_contains(&t,"TC")
        || t.contains("CAM RIP") || wb_contains(&t,"CAM") { return "SD"; }
    UNKNOWN_QUALITY
}

/// Busca por palavra com fronteiras \b ASCII.
fn wb_contains(text: &str, word: &str) -> bool {
    let tu = text.to_uppercase();
    let wu = word.to_uppercase();
    let mut start = 0;
    while let Some(pos) = tu[start..].find(&wu) {
        let abs = start + pos;
        let before_ok = abs == 0 || !tu.as_bytes()[abs - 1].is_ascii_alphanumeric();
        let after = abs + wu.len();
        let after_ok = after >= tu.len() || !tu.as_bytes()[after].is_ascii_alphanumeric();
        if before_ok && after_ok { return true; }
        start = abs + 1;
    }
    false
}

pub fn stream_quality(stream: &StreamRef) -> String {
    stream.quality.clone().filter(|q| !q.is_empty())
        .unwrap_or_else(|| quality_from_title(&stream.title).to_string())
}

// ─── Detecção de pack ────────────────────────────────────────────────────────

pub fn is_season_pack_release(stream: &StreamRef, season: Option<i64>) -> bool {
    let Some(season) = season else { return false };
    let p = parse_title_season_episode(&stream.title);
    if p.complete && p.seasons.is_empty() { return true; }
    if !p.episodes.is_empty() { return false; }
    if !p.seasons.is_empty() { return p.seasons.contains(&season); }
    p.season_pack
}

// ─── Cotas ───────────────────────────────────────────────────────────────────

pub fn limit_by_quality(qualities: &[&str], quality_limits: &QualityLimits) -> Vec<usize> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut kept = Vec::with_capacity(qualities.len());
    for (i, q) in qualities.iter().enumerate() {
        let raw = quality_limits.get(*q).copied();
        let limit = match raw {
            None | Some(f64::INFINITY) => usize::MAX,
            Some(v) if v >= 100.0 => usize::MAX,
            Some(v) => clamp_limit(v) as usize,
        };
        let count = counts.get(q).copied().unwrap_or(0);
        if count >= limit { continue; }
        counts.insert(q, count + 1);
        kept.push(i);
    }
    kept
}

pub fn limit_by_quality_and_indexer(
    streams: &[&StreamRef], quality_limits: &QualityLimits, max_per_indexer: f64,
    exempt: &HashSet<usize>, indexer_limits: &QualityLimits, reserved_br: &HashSet<usize>,
) -> Vec<usize> {
    let mut qc: HashMap<String, usize> = HashMap::new();
    let mut ic: HashMap<String, usize> = HashMap::new();
    let gl = clamp_limit(max_per_indexer);
    let mut kept = Vec::with_capacity(streams.len());
    for (i, s) in streams.iter().enumerate() {
        let quality = stream_quality(s);
        let ql = match quality_limits.get(&quality).copied() {
            None | Some(f64::INFINITY) => usize::MAX,
            Some(v) if v >= 100.0 => usize::MAX,
            Some(v) => clamp_limit(v) as usize,
        };
        let qn = qc.get(&quality).copied().unwrap_or(0);
        let reserved = reserved_br.contains(&i);
        if !reserved && qn >= ql { continue; }
        let source = s.indexer.as_ref().map(|x| js_trim(x).to_lowercase()).unwrap_or_default();
        let sn = if source.is_empty() { 0 } else { ic.get(&source).copied().unwrap_or(0) };
        let sl = if source.is_empty() { 0.0 }
            else if let Some(v) = indexer_limits.get(&source) { clamp_limit(*v) } else { gl };
        if !source.is_empty() && !exempt.contains(&i) && sl != 0.0 && sn >= sl as usize { continue; }
        if !reserved { qc.insert(quality, qn + 1); }
        if !source.is_empty() { ic.insert(source, sn + 1); }
        kept.push(i);
    }
    kept
}

// ─── Seleção de candidatos ───────────────────────────────────────────────────

pub struct SelectCandidatesOpts {
    pub max_results: f64,
    pub quality_limits: QualityLimits,
    pub br_reserved_slots: f64,
    pub br_reserved_per_quality: f64,
    pub candidate_factor: f64,
    pub br_first: bool,
}
impl Default for SelectCandidatesOpts {
    fn default() -> Self {
        Self { max_results: 40.0, quality_limits: HashMap::new(), br_reserved_slots: 0.0,
            br_reserved_per_quality: 0.0, candidate_factor: 1.0, br_first: true }
    }
}

/// Seleciona candidatos no pool pré-debrid, separando espaço por qualidade.
pub fn select_quality_candidates(streams: &[&StreamRef], opts: &SelectCandidatesOpts) -> Vec<usize> {
    let pool_size = clamp_limit(opts.max_results) as usize;
    // NaN < 100 = false no TS; qualities sem limite explícito NÃO estão em custom.
    let custom: Vec<&str> = QUALITY_KEYS.iter()
        .filter(|q| opts.quality_limits.get(**q).map(|&v| v < 100.0).unwrap_or(false))
        .copied().collect();
    let custom_set: HashSet<&str> = custom.iter().copied().collect();
    let mut buckets: HashMap<&str, Vec<usize>> = HashMap::new();
    for q in &custom { buckets.insert(q, Vec::new()); }
    for (i, s) in streams.iter().enumerate() {
        let q = stream_quality(s);
        if let Some(b) = buckets.get_mut(q.as_str()) { b.push(i); }
    }
    let mut selected = HashSet::new();
    let mut positions: HashMap<&str, usize> = custom.iter().map(|q| (*q, 0)).collect();
    let mut counts: HashMap<String, usize> = custom.iter().map(|q| (q.to_string(), 0)).collect();
    let factor = clamp_limit(opts.candidate_factor).max(1.0) as usize;
    let targets: HashMap<&str, usize> = custom.iter().map(|q| {
        let lim = opts.quality_limits.get(*q).copied().unwrap_or(0.0);
        (*q, clamp_limit(lim) as usize * factor)
    }).collect();
    let br_target = if opts.br_first { pool_size } else { clamp_limit(opts.br_reserved_slots) as usize };
    let per_faixa = clamp_limit(opts.br_reserved_per_quality) as usize;
    if per_faixa > 0 {
        let mut fc: HashMap<String, usize> = HashMap::new();
        for (i, s) in streams.iter().enumerate() {
            if selected.len() >= pool_size || selected.len() >= br_target { break; }
            if !s.is_br || s.is_lied || selected.contains(&i) { continue; }
            let quality = stream_quality(s);
            let usados = fc.get(&quality).copied().unwrap_or(0);
            if usados >= per_faixa { continue; }
            if custom_set.contains(quality.as_str())
                && counts.get(quality.as_str()).copied().unwrap_or(0)
                    >= targets.get(quality.as_str()).copied().unwrap_or(0) { continue; }
            fc.insert(quality.clone(), usados + 1);
            selected.insert(i);
            if custom_set.contains(quality.as_str()) { *counts.entry(quality.clone()).or_insert(0) += 1; }
        }
    }
    for (i, s) in streams.iter().enumerate() {
        if selected.len() >= pool_size || selected.len() >= br_target { break; }
        if !s.is_br || s.is_lied || selected.contains(&i) { continue; }
        let quality = stream_quality(s);
        if custom_set.contains(quality.as_str())
            && counts.get(quality.as_str()).copied().unwrap_or(0)
                >= targets.get(quality.as_str()).copied().unwrap_or(0) { continue; }
        selected.insert(i);
        if custom_set.contains(quality.as_str()) { *counts.entry(quality).or_insert(0) += 1; }
    }
    let mut progressed = true;
    while selected.len() < pool_size && progressed {
        progressed = false;
        for q in &custom {
            let bucket = buckets.get(q).map(|b| b.as_slice()).unwrap_or(&[]);
            let mut pos = positions.get(q).copied().unwrap_or(0);
            while pos < bucket.len() && selected.contains(&bucket[pos]) { pos += 1; }
            positions.insert(q, pos);
            if counts.get(*q).copied().unwrap_or(0) >= targets.get(*q).copied().unwrap_or(0) { continue; }
            if pos >= bucket.len() { continue; }
            selected.insert(bucket[pos]);
            positions.insert(q, pos + 1);
            *counts.entry(q.to_string()).or_insert(0) += 1;
            progressed = true;
            if selected.len() >= pool_size { break; }
        }
    }
    for (i, s) in streams.iter().enumerate() {
        if selected.len() >= pool_size { break; }
        if selected.contains(&i) || custom_set.contains(stream_quality(s).as_str()) { continue; }
        selected.insert(i);
    }
    let mut result: Vec<usize> = selected.into_iter().collect();
    result.sort();
    result
}

// ─── Reserva BR ──────────────────────────────────────────────────────────────

pub struct LimitBrOpts {
    pub br_reserved_slots: f64,
    pub br_reserved_per_quality: f64,
    pub max_results: f64,
    pub br_only: bool,
    pub quality_limits: QualityLimits,
    pub br_first: bool,
    pub max_per_indexer: f64,
    pub indexer_limits: QualityLimits,
    pub season: Option<i64>,
}
impl Default for LimitBrOpts {
    fn default() -> Self {
        Self { br_reserved_slots: 0.0, br_reserved_per_quality: 0.0, max_results: 40.0,
            br_only: false, quality_limits: HashMap::new(), br_first: true,
            max_per_indexer: 0.0, indexer_limits: HashMap::new(), season: None }
    }
}

fn dub_rank(s: &StreamRef) -> u8 {
    (if s.is_dubbed { 2 } else { 0 }) + (if s.is_dub_claim { 1 } else { 0 })
}

/// Reserva origem BR, aplica cotas finais, devolve índices selecionados.
pub fn limit_reserving_br(streams: &[StreamRef], opts: &LimitBrOpts) -> Vec<usize> {
    let max_results = clamp_limit(opts.max_results) as usize;
    let pool: Vec<usize> = if opts.br_only {
        streams.iter().enumerate().filter(|(_, s)| s.is_br).map(|(i, _)| i).collect()
    } else { (0..streams.len()).collect() };
    let reserved = if opts.br_first { usize::MAX } else { clamp_limit(opts.br_reserved_slots) as usize };
    let mut priority: Vec<usize> = pool.iter().copied()
        .filter(|&i| streams[i].is_br && !streams[i].is_lied).collect();
    priority.sort_by(|&a, &b| dub_rank(&streams[b]).cmp(&dub_rank(&streams[a])));
    let priority: Vec<usize> = priority.into_iter().take(reserved).collect();
    let prioritized: HashSet<usize> = priority.iter().copied().collect();
    let br_slots = clamp_limit(opts.br_reserved_slots) as usize;
    let mut rbv: Vec<usize> = pool.iter().copied()
        .filter(|&i| streams[i].is_br && !streams[i].is_lied).collect();
    rbv.sort_by(|&a, &b| dub_rank(&streams[b]).cmp(&dub_rank(&streams[a])));
    let reserved_br: HashSet<usize> = rbv.into_iter().take(br_slots).collect();
    let qai_order: Vec<usize> = { let mut v = priority.clone(); for &i in &pool { if !prioritized.contains(&i) { v.push(i); } } v };
    let refs: Vec<&StreamRef> = qai_order.iter().map(|&i| &streams[i]).collect();
    let kept_idx = limit_by_quality_and_indexer(&refs, &opts.quality_limits, opts.max_per_indexer, &reserved_br, &opts.indexer_limits, &reserved_br);
    let kept: HashSet<usize> = kept_idx.iter().map(|&qi| qai_order[qi]).collect();
    let eligible: Vec<usize> = pool.iter().copied().filter(|i| kept.contains(i)).collect();
    let mut br_streams: Vec<usize> = eligible.iter().copied()
        .filter(|&i| streams[i].is_br && !streams[i].is_lied).collect();
    br_streams.sort_by(|&a, &b| dub_rank(&streams[b]).cmp(&dub_rank(&streams[a])));
    let per_faixa = clamp_limit(opts.br_reserved_per_quality) as usize;
    let mut garantidas: Vec<usize> = Vec::new();
    if per_faixa > 0 {
        let mut fc: HashMap<String, usize> = HashMap::new();
        let mut cp: HashSet<String> = HashSet::new();
        for &si in &br_streams {
            let q = stream_quality(&streams[si]);
            let c = fc.get(&q).copied().unwrap_or(0);
            if c >= per_faixa { continue; }
            if opts.season.is_some() && is_season_pack_release(&streams[si], opts.season) { continue; }
            cp.insert(q.clone()); fc.insert(q, c + 1); garantidas.push(si);
        }
        if let Some(season) = opts.season {
            let usados: HashSet<usize> = garantidas.iter().copied().collect();
            for q in &QUALITY_KEYS {
                if cp.contains(*q) { continue; }
                if let Some(p) = br_streams.iter().copied().find(|&si| {
                    !usados.contains(&si) && stream_quality(&streams[si]) == *q
                        && is_season_pack_release(&streams[si], Some(season))
                }) { garantidas.push(p); cp.insert(q.to_string()); }
            }
        }
    }
    let encaixa = |sel: &mut Vec<usize>, gar: &[usize]| {
        let mut dentro: HashSet<usize> = sel.iter().copied().collect();
        for &g in gar {
            if dentro.contains(&g) { continue; }
            if sel.len() < max_results { sel.push(g); dentro.insert(g); continue; }
            let Some(pos) = sel.iter().rposition(|&s| !streams[s].is_br) else { break };
            dentro.remove(&sel[pos]); sel[pos] = g; dentro.insert(g);
        }
    };
    if opts.br_first {
        let mut sel: Vec<usize> = br_streams.iter().copied()
            .chain(eligible.iter().copied().filter(|i| !streams[*i].is_br))
            .take(max_results).collect();
        if !garantidas.is_empty() { encaixa(&mut sel, &garantidas); }
        return sel;
    }
    let gs: HashSet<usize> = garantidas.iter().copied().collect();
    let rl = clamp_limit(opts.br_reserved_slots) as usize;
    let mut reserved: Vec<usize> = garantidas.clone();
    reserved.extend(br_streams.iter().copied().filter(|i| !gs.contains(i)));
    let reserved: Vec<usize> = reserved.into_iter().take(rl.max(garantidas.len())).collect();
    let cp: Vec<usize> = eligible.iter().copied().take(max_results).collect();
    let mut chosen: HashSet<usize> = cp.iter().copied().collect();
    for &r in &reserved {
        if chosen.contains(&r) { continue; }
        if let Some(rep) = cp.iter().rev().copied().find(|c| chosen.contains(c) && !streams[*c].is_br) {
            chosen.remove(&rep);
        }
        if chosen.len() < max_results { chosen.insert(r); }
    }
    let mut sel: Vec<usize> = eligible.iter().copied().filter(|i| chosen.contains(i)).take(max_results).collect();
    if !garantidas.is_empty() { encaixa(&mut sel, &garantidas); }
    sel
}
