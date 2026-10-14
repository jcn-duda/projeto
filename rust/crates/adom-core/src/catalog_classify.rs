//! Porte de `foreignProofLabel`, `classifyByTitle` e `classifyWithEvidence`
//! (`src/utils/catalog-classify.ts`) — a CLASSIFICAÇÃO do catálogo durável e o
//! RÓTULO DA PROVA gravado na linha.
//!
//! As três são uma fachada sobre os classificadores já portados:
//! `foreign_proof_label` reusa `strong_en_scene_mark` e
//! `has_explicit_foreign_audio`; `classify_by_title`/`classify_with_evidence`
//! reusam `audio_bucket` e `foreign_verdict`. Como no TS, o rótulo `cena`
//! (marca de cena EN forte) vence o rótulo `audio` (idioma estrangeiro
//! explícito), e a ausência de prova condena sem marca forte (`sim`); do lado
//! BR a absolvição medida nos ARQUIVOS (`arquivo`) é durável e a do título do
//! post (`titulo`) não congela no upsert.
//!
//! Faltavam no porte dois helpers de `audio-quality.ts` que as três consomem —
//! `foreignVerdict` e `audioBucket`. Ambos são implementados PRIVADOS aqui,
//! reusando os módulos já portados (`audio_presentation`, `pt_audio_guards`,
//! `audio_cleanup_verdicts`, `br_origin`, `audio_lang`), para não expor API
//! nova nem duplicar listas calibradas. A única regex local é
//! `declaraDublagem` (`/\b(?:DUB|DUBBED|DUBLAD[OA]|DUBLAGEM)\b/i`), que não
//! tinha porte.
//!
//! As listas calibradas do audit (`ptMarkers`/`enGroups`) entram por parâmetro,
//! como em `audio_cleanup_verdicts`: função pura, sem ler `config.*`.

use std::sync::OnceLock;

use regex::Regex;

use crate::audio_cleanup_verdicts::{has_pt_audio_mark, strong_en_scene_mark};
use crate::audio_lang::foreign_lang_named_for_bucket;
use crate::audio_presentation::{audio_from_title, looks_pt_br};
use crate::br_origin::{br_origin_mark, has_pt_signs};
use crate::pt_audio_guards::has_explicit_foreign_audio;

/// `Proof`: o que fica gravado na linha do catálogo. `audio` sai vazio nas
/// classificações — o rótulo de áudio não vem do título — como no TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Proof {
    pub bucket: &'static str,
    pub audio: &'static str,
    pub foreign_proof: &'static str,
    pub pt_proof: &'static str,
}

/// `declaraDublagem`: `DUB`/`DUBBED`/`DUBLAD[OA]`/`DUBLAGEM` como palavra.
/// Dublagem declarada no título impede que o grupo de cena EN sozinho condene.
fn declara_dublagem_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?-u:\b)(?i:DUB|DUBBED|DUBLAD[OA]|DUBLAGEM)(?-u:\b)")
            .expect("declaração de dublagem compila")
    })
}

/// `foreignProofLabel`: o primeiro candidato com marca de cena EN forte vira
/// `cena`; sem ela, o primeiro com idioma estrangeiro explícito vira `audio`;
/// sem nenhuma prova, `sim`.
pub fn foreign_proof_label(
    candidates: &[&str],
    pt_markers: &[&str],
    en_groups: &[&str],
) -> &'static str {
    for candidate in candidates {
        if strong_en_scene_mark(candidate, pt_markers, en_groups).is_some() {
            return "cena";
        }
    }
    for candidate in candidates {
        if has_explicit_foreign_audio(candidate) {
            return "audio";
        }
    }
    "sim"
}

/// `audioBucket` (helper privado que faltava no porte): `dub`/`dual`/`pt`/
/// `lixo`. `Dual` sem PT ao lado sobe para `dub` via `looks_pt_br`; com idioma
/// estrangeiro nomeado cai em `lixo`.
fn audio_bucket(title: &str) -> &'static str {
    if looks_pt_br(title) {
        return "dub";
    }
    if audio_from_title(title) == "Dual" {
        return if foreign_lang_named_for_bucket(title) {
            "lixo"
        } else {
            "dual"
        };
    }
    if has_pt_signs(title) || br_origin_mark(title) {
        return "pt";
    }
    "lixo"
}

/// `foreignVerdict` (helper privado que faltava no porte): `absolve`/`condena`/
/// `unknown`. Ausência de PT nunca condena — condenar exige prova positiva de
/// idioma estrangeiro. Um único sinal PT em qualquer candidato absolve.
fn foreign_verdict(
    filename: &str,
    video_paths: &[&str],
    pt_markers: &[&str],
    en_groups: &[&str],
) -> &'static str {
    let candidates: Vec<&str> = std::iter::once(filename)
        .chain(video_paths.iter().copied())
        .filter(|path| !path.is_empty())
        .collect();
    let tem_sinal_pt = candidates.iter().any(|path| {
        looks_pt_br(path)
            || has_pt_signs(path)
            || has_pt_audio_mark(path, pt_markers)
            || br_origin_mark(path)
    });
    if tem_sinal_pt {
        return "absolve";
    }
    let prova_estrangeira = candidates.iter().any(|path| {
        has_explicit_foreign_audio(path)
            || (strong_en_scene_mark(path, pt_markers, en_groups).is_some()
                && !declara_dublagem_re().is_match(path))
    });
    if prova_estrangeira {
        "condena"
    } else {
        "unknown"
    }
}

/// `classifyByTitle`: sem evidência de arquivo, o título do post é a única
/// fonte; a absolvição fica como `titulo` (fraca, não congela no upsert).
pub fn classify_by_title(filename: &str, pt_markers: &[&str], en_groups: &[&str]) -> Proof {
    let verdict = foreign_verdict(filename, &[], pt_markers, en_groups);
    let (foreign_proof, pt_proof) = match verdict {
        "condena" => (
            foreign_proof_label(std::slice::from_ref(&filename), pt_markers, en_groups),
            "",
        ),
        "absolve" => ("", "titulo"),
        _ => ("", ""),
    };
    Proof {
        bucket: audio_bucket(filename),
        audio: "",
        foreign_proof,
        pt_proof,
    }
}

/// `classifyWithEvidence`: prova dos ARQUIVOS reais; a absolvição fica como
/// `arquivo` (medida, durável, congela). `evidence` vazia conta como ausente.
pub fn classify_with_evidence(
    filename: &str,
    evidence: Option<&str>,
    pt_markers: &[&str],
    en_groups: &[&str],
) -> Proof {
    let paths: Vec<&str> = evidence.filter(|e| !e.is_empty()).into_iter().collect();
    let verdict = foreign_verdict(filename, &paths, pt_markers, en_groups);
    let (foreign_proof, pt_proof) = match verdict {
        "condena" => {
            let mut candidates = Vec::with_capacity(paths.len() + 1);
            candidates.push(filename);
            candidates.extend(paths.iter().copied());
            (foreign_proof_label(&candidates, pt_markers, en_groups), "")
        }
        "absolve" => ("", "arquivo"),
        _ => ("", ""),
    };
    Proof {
        bucket: audio_bucket(filename),
        audio: "",
        foreign_proof,
        pt_proof,
    }
}
