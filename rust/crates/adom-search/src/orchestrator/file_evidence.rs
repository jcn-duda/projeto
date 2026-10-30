//! Prova de ARQUIVO por hash (`idx:v14:file:<hash>`) aplicada aos itens antes
//! do build — o `applyFileEvidence` do Node (`stream-file-evidence.ts` no `esm`),
//! que o corte nativo nunca recebeu.
//!
//! O título do post é PROMESSA; o que o play viu dentro do torrent (rótulo de
//! áudio, marca de cena EN, resolução e nome do maior vídeo) é PROVA. Sem este
//! passo nenhum item virava dublado por prova: o claim ficava eternamente "sem
//! prova", a auditoria de dublagem refazia o play a cada busca e invalidava a
//! obra — e a lista pronta nunca ficava no cache.
//!
//! Mesma régua do TS: rótulo de áudio OU marca EN anexam `provenAudio` (vazio
//! com marca EN também é veredito: "não é dublado") e `provenName`; resolução
//! conhecida anexa `provenQuality`.

use std::borrow::Cow;
use std::collections::BTreeMap;

use adom_core::UNKNOWN_QUALITY;

use super::file_sizes::hashes_of;
use crate::raw_item::RawItem;

/// O que o play provou sobre um hash (`{a, e, q, n}` do índice).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProvenFile {
    /// Rótulo de áudio dos nomes de arquivo (`Dual`, `Dublado`…); vazio = sem rótulo.
    pub audio: String,
    /// Release de cena EN reconhecida nos nomes (prova negativa de dublagem).
    pub en: bool,
    /// Resolução do maior vídeo; vazio ou `UNKNOWN_QUALITY` = sem prova.
    pub quality: String,
    /// Nome do maior vídeo (vazio em coleção multiobra).
    pub name: String,
}

/// Prova de arquivo lida por hash (chave minúscula). Hash sem prova não entra
/// no mapa: o item segue só com a promessa do título.
pub trait FileEvidenceSource: Send + Sync {
    fn evidence_for(&self, hashes: &[String]) -> BTreeMap<String, ProvenFile>;
}

/// Aplica a prova aos itens. Só clona a lista quando algum item muda; sem fonte
/// ou sem hash a fonte nem é chamada.
pub(super) fn apply_file_evidence<'a>(
    source: Option<&dyn FileEvidenceSource>,
    items: &'a [RawItem],
) -> Cow<'a, [RawItem]> {
    let Some(source) = source else {
        return Cow::Borrowed(items);
    };
    let hashes = hashes_of(items);
    if hashes.is_empty() {
        return Cow::Borrowed(items);
    }
    let proofs = source.evidence_for(&hashes);
    if proofs.is_empty() {
        return Cow::Borrowed(items);
    }
    let mut out = items.to_vec();
    for item in &mut out {
        if let Some(proof) = proofs.get(&item.hash()) {
            apply_one(item, proof);
        }
    }
    Cow::Owned(out)
}

fn apply_one(item: &mut RawItem, proof: &ProvenFile) {
    if !proof.audio.is_empty() || proof.en {
        item.proven_audio = Some(proof.audio.clone());
        item.proven_name = Some(proof.name.clone()).filter(|name| !name.is_empty());
    }
    if !proof.quality.is_empty() && proof.quality != UNKNOWN_QUALITY {
        item.proven_quality = Some(proof.quality.clone());
    }
}

#[cfg(test)]
#[path = "file_evidence_tests.rs"]
mod file_evidence_tests;
