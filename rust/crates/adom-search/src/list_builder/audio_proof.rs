//! Prova de áudio do stream — o trecho de `toStremioStream`
//! (`src/utils/search-names.ts`) que decide chip, `_dubbed` e `_dubClaim`.
//!
//! O título do post é PROMESSA; só a prova de ARQUIVO (`provenAudio` /
//! `provenName`, gravada pelo play no índice e anexada pelo Node em
//! `applyFileEvidence`) vira dublado e chip DUB/DUAL/NAC. Sem prova o chip some
//! (o rótulo BR fica) e o título só conta como promessa (`dub_claim`), que o
//! `dn=` de cena EN do próprio torrent ainda pode anular.

use adom_core::{
    audio_from_title, dn_contradicts_dub_claim, en_scene_mirror_title, explicit_pt_audio,
    looks_pt_br, magnet_display_name,
};

use crate::raw_item::RawItem;

/// Origem BR do stream (`isBr` do `toStremioStream`): título PT (acento,
/// vocabulário ou `ptTitleDual`) prova sozinho; o flag do indexer só vale se o
/// título não for o nome de cena EN intacto — agregador BR republica magnet
/// gringo ("Barbie (2023) 1080p WEBRip [YTS.MX]") e o flag dava vaga BR a ele.
pub fn origin_is_br(item: &RawItem, title: &str, audit: &AudioAudit) -> bool {
    if item.pt_title_dual || looks_pt_br(title) {
        return true;
    }
    if !item.is_br {
        return false;
    }
    let pt: Vec<&str> = audit.pt_markers.iter().map(String::as_str).collect();
    let en: Vec<&str> = audit.en_groups.iter().map(String::as_str).collect();
    !en_scene_mirror_title(title, &pt, &en)
}

/// `config.audioAudit` do Node (`src/config/audit.ts`): mesmas listas e o
/// mesmo kill-switch `AUDIO_AUDIT`.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioAudit {
    pub enabled: bool,
    pub pt_markers: Vec<String>,
    pub en_groups: Vec<String>,
}

const PT_MARKERS: &str =
    "dublado,dublada,dublagem,dubbed,dual audio,dual,pt br,ptbr,portugues,portuguese,nacional,fleg";
const EN_GROUPS: &str = "rarbg,killers,ettv,afm72,tovar,evo,megusta,galaxyrg,glxrc,yts,fgt,ntb,roarb,oxy,bae,drs,huzzah,tgx,ethel,yify";

fn csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

impl Default for AudioAudit {
    fn default() -> Self {
        AudioAudit {
            enabled: true,
            pt_markers: csv(PT_MARKERS),
            en_groups: csv(EN_GROUPS),
        }
    }
}

impl AudioAudit {
    /// Valores crus do env (`AUDIO_AUDIT`, `AUDIO_AUDIT_PT_MARKERS`,
    /// `AUDIO_AUDIT_EN_GROUPS`); ausente ou vazio cai no default do Node.
    pub fn from_env_values(enabled: Option<&str>, pt: Option<&str>, en: Option<&str>) -> Self {
        let mut audit = AudioAudit::default();
        if let Some(raw) = enabled {
            audit.enabled = raw.trim() == "true";
        }
        if let Some(raw) = pt.filter(|s| !s.trim().is_empty()) {
            audit.pt_markers = csv(raw);
        }
        if let Some(raw) = en.filter(|s| !s.trim().is_empty()) {
            audit.en_groups = csv(raw);
        }
        audit
    }
}

/// Veredito de áudio de UM item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioProof {
    /// Áudio da coluna do nome (`audioForChip`): DUB/DUAL/NAC só com prova.
    pub chip_audio: String,
    /// `_dubbed`: só prova POSITIVA de arquivo, e nunca com mentira provada.
    pub dubbed: bool,
    /// `_dubClaim`: promessa do post que nenhuma evidência contradiz.
    pub dub_claim: bool,
}

fn is_dub_label(audio: &str) -> bool {
    matches!(audio, "Dublado" | "Dual" | "Nacional")
}

pub fn audio_proof(item: &RawItem, title: &str, is_br: bool, audit: &AudioAudit) -> AudioProof {
    let title_audio = audio_from_title(title);
    let proven = item.proven_audio.as_deref();
    // Prova vazia (release EN) é veredito sobre DUBLADO, não sobre o rótulo:
    // "Legendado" no título concorda com ela e fica.
    let audio = match proven {
        Some(p) if !p.is_empty() => p.to_string(),
        Some(_) if title_audio == "Legendado" => "Legendado".to_string(),
        Some(_) => String::new(),
        None => title_audio.to_string(),
    };
    // `brOriginOnly` nunca promete: origem não prova áudio.
    let title_claim = if item.br_origin_only {
        false
    } else if is_br {
        is_dub_label(title_audio)
    } else {
        explicit_pt_audio(title)
    };
    let positive_proof = match proven {
        Some(p) => is_dub_label(p),
        None => item.proven_name.as_deref().is_some_and(explicit_pt_audio),
    };
    let claim_contradicted = match proven {
        Some(p) => !is_dub_label(p),
        None => {
            let dn = magnet_display_name(
                item.magnet.as_deref(),
                item.magnet_uri.as_deref(),
                item.guid.as_deref(),
            );
            let pt: Vec<&str> = audit.pt_markers.iter().map(String::as_str).collect();
            let en: Vec<&str> = audit.en_groups.iter().map(String::as_str).collect();
            dn_contradicts_dub_claim(&dn, audit.enabled, &pt, &en)
        }
    };
    let chip_audio = if positive_proof || !is_dub_label(&audio) {
        audio
    } else {
        String::new()
    };
    AudioProof {
        chip_audio,
        dubbed: positive_proof && !item.lied,
        dub_claim: title_claim && !claim_contradicted && !item.lied,
    }
}

#[cfg(test)]
#[path = "audio_proof_tests.rs"]
mod audio_proof_tests;
