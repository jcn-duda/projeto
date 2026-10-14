//! Porte de `src/utils/stream-quotas-candidate.ts`: `QUALITY_KEYS`,
//! `streamQuality` e `selectQualityCandidates`.
//!
//! O miolo da seleção já está portado em [`crate::stream_quotas_extra`]
//! (`selection.rs`). Este módulo reaproveita essa seleção e acrescenta o que o
//! TS faz de diferente:
//! - `qualityFromTitle` é o de `src/utils/audio-quality.ts`, portado aqui sobre
//!   `strip_quality_tag_blob` de `audio_presentation`. O `quality_from_title` de
//!   `stream_quotas_extra` NÃO serve: foi portado de uma reimplementação
//!   (`scripts/golden/generate-stream-quotas-extra.mjs`) e diverge deste.
//! - `streamQuality` lê `title || name`; o `StreamRef` só tem `title`.
//!
//! Mapeamento do `StreamCandidate`:
//! - `_quality` vira `quality` (falsy do JS, `""` ou ausente, cai na
//!   classificação do título).
//! - `_br` e `_lied` viram `is_br` e `is_lied`, os únicos campos que a seleção lê.

use std::sync::OnceLock;

use fancy_regex::Regex;

use crate::audio_presentation::strip_quality_tag_blob;
use crate::stream_quotas_extra::{
    select_quality_candidates, SelectCandidatesOpts, StreamRef, UNKNOWN_QUALITY,
};

/// Candidato com os campos que o TS lê na seleção.
#[derive(Debug, Clone, Default)]
pub struct CandidateStream {
    pub title: String,
    pub name: String,
    pub quality: Option<String>,
    pub is_br: bool,
    pub is_lied: bool,
}

/// `streamQuality(stream)` = `stream._quality || qualityFromTitle(title || name)`.
pub fn candidate_stream_quality(quality: Option<&str>, title: &str, name: &str) -> String {
    match quality.filter(|q| !q.is_empty()) {
        Some(q) => q.to_string(),
        None => {
            let source = if title.is_empty() { name } else { title };
            quality_from_title_ts(source).to_string()
        }
    }
}

/// `qualityFromTitle` de `src/utils/audio-quality.ts`.
pub fn quality_from_title_ts(title: &str) -> &'static str {
    let upper = strip_quality_tag_blob(title)
        .to_uppercase()
        .replace('_', " ");
    let t = glue_re().replace_all(&upper, "$1 ").into_owned();
    if has_word(&t, "2160P|4K|UHD") {
        return "2160p";
    }
    if has_word(&t, "1080P") {
        return "1080p";
    }
    if has_word(&t, "720P") {
        return "720p";
    }
    if has_word(&t, "480P") {
        return "480p";
    }
    if has_word(&t, SD_ALTS) {
        return "SD";
    }
    UNKNOWN_QUALITY
}

/// `/(RIP|DL|WEB|HDTV)(?=(?:2160|1080|720|480)P\b)/g`: separa a fonte colada à resolução.
fn glue_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(RIP|DL|WEB|HDTV)(?=(?:2160|1080|720|480)P(?![A-Za-z0-9_]))")
            .expect("regex fixa")
    })
}

/// Alternativas SD de `qualityFromTitle` (um OU, a ordem não importa).
const SD_ALTS: &str = "576P|540P|360P|240P|SDTV|DVD5|DVD9|DVD[- ]?R|DVD[- ]?(?:RIP|SCR)|VHS[- ]?RIP|TS|TC|CAM[- ]?RIP|CAM";

/// `/\b(?:alts)\b/` sobre texto já em maiúsculas, com fronteiras ASCII do JS.
fn has_word(text: &str, alts: &str) -> bool {
    let pattern = format!("(?<![A-Za-z0-9_])(?:{alts})(?![A-Za-z0-9_])");
    Regex::new(&pattern)
        .map(|re| re.is_match(text).unwrap_or(false))
        .unwrap_or(false)
}

/// `selectQualityCandidates(streams, opts)`: devolve os índices mantidos, na
/// ordem original, como a versão TS devolve o subconjunto.
pub fn select_candidate_streams(
    streams: &[CandidateStream],
    opts: &SelectCandidatesOpts,
) -> Vec<usize> {
    let refs: Vec<StreamRef> = streams.iter().map(to_stream_ref).collect();
    let borrowed: Vec<&StreamRef> = refs.iter().collect();
    select_quality_candidates(&borrowed, opts)
}

/// Adaptador: a qualidade já sai resolvida (`candidate_stream_quality`), então
/// `stream_quality` do `StreamRef` nunca chama o classificador divergente.
fn to_stream_ref(stream: &CandidateStream) -> StreamRef {
    let quality = candidate_stream_quality(stream.quality.as_deref(), &stream.title, &stream.name);
    StreamRef {
        title: String::new(),
        quality: Some(quality),
        indexer: None,
        is_br: stream.is_br,
        is_dubbed: false,
        is_dub_claim: false,
        is_lied: stream.is_lied,
        is_season_pack: false,
    }
}
