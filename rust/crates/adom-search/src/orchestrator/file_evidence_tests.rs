use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::json;

use super::{apply_file_evidence, FileEvidenceSource, ProvenFile};
use crate::raw_item::{raw_item_from_value, RawItem};

const H1: &str = "1111111111111111111111111111111111111111";
const H2: &str = "2222222222222222222222222222222222222222";

struct Fake {
    proofs: BTreeMap<String, ProvenFile>,
    asked: Mutex<Vec<Vec<String>>>,
}

impl FileEvidenceSource for Fake {
    fn evidence_for(&self, hashes: &[String]) -> BTreeMap<String, ProvenFile> {
        self.asked.lock().unwrap().push(hashes.to_vec());
        self.proofs
            .iter()
            .filter(|(hash, _)| hashes.contains(hash))
            .map(|(hash, proof)| (hash.clone(), proof.clone()))
            .collect()
    }
}

fn fake(proofs: &[(&str, ProvenFile)]) -> Fake {
    Fake {
        proofs: proofs
            .iter()
            .map(|(hash, proof)| (hash.to_string(), proof.clone()))
            .collect(),
        asked: Mutex::new(Vec::new()),
    }
}

fn item(hash: &str, title: &str) -> RawItem {
    raw_item_from_value(&json!({ "title": title, "infoHash": hash.to_uppercase() }))
}

fn proof(audio: &str, en: bool, quality: &str, name: &str) -> ProvenFile {
    ProvenFile {
        audio: audio.into(),
        en,
        quality: quality.into(),
        name: name.into(),
    }
}

#[test]
fn rotulo_de_audio_e_resolucao_viram_prova() {
    let source = fake(&[(H1, proof("Dual", false, "1080p", "Filme.1080p.DUAL.mkv"))]);
    let items = vec![item(H1, "Filme 2020 DUBLADO"), item(H2, "Outro 2020")];
    let out = apply_file_evidence(Some(&source), &items);
    assert_eq!(out[0].proven_audio.as_deref(), Some("Dual"));
    assert_eq!(out[0].proven_name.as_deref(), Some("Filme.1080p.DUAL.mkv"));
    assert_eq!(out[0].proven_quality.as_deref(), Some("1080p"));
    // Hash sem prova fica como veio.
    assert_eq!(out[1].proven_audio, None);
    assert_eq!(out[1].proven_quality, None);
    // Os hashes pedidos são únicos e minúsculos.
    assert_eq!(
        *source.asked.lock().unwrap(),
        vec![vec![H1.to_string(), H2.to_string()]]
    );
}

#[test]
fn marca_en_sem_rotulo_e_veredito_vazio() {
    let source = fake(&[(H1, proof("", true, "", "Filme.H264-METCON.mkv"))]);
    let items = vec![item(H1, "Filme 2020 DUBLADO")];
    let out = apply_file_evidence(Some(&source), &items);
    assert_eq!(out[0].proven_audio.as_deref(), Some(""));
    assert_eq!(out[0].proven_quality, None);
}

#[test]
fn so_resolucao_nao_mexe_no_audio() {
    let source = fake(&[(H1, proof("", false, "720p", "x.mkv"))]);
    let items = vec![item(H1, "Filme 2020")];
    let out = apply_file_evidence(Some(&source), &items);
    assert_eq!(out[0].proven_audio, None);
    assert_eq!(out[0].proven_name, None);
    assert_eq!(out[0].proven_quality.as_deref(), Some("720p"));
}

#[test]
fn resolucao_desconhecida_nao_vira_prova() {
    let source = fake(&[(H1, proof("Dual", false, adom_core::UNKNOWN_QUALITY, ""))]);
    let items = vec![item(H1, "Filme 2020")];
    let out = apply_file_evidence(Some(&source), &items);
    assert_eq!(out[0].proven_quality, None);
    assert_eq!(out[0].proven_audio.as_deref(), Some("Dual"));
    assert_eq!(out[0].proven_name, None);
}

#[test]
fn sem_fonte_ou_sem_prova_nao_clona() {
    let items = vec![item(H1, "Filme 2020")];
    assert!(matches!(
        apply_file_evidence(None, &items),
        Cow::Borrowed(_)
    ));
    let vazia = fake(&[]);
    assert!(matches!(
        apply_file_evidence(Some(&vazia), &items),
        Cow::Borrowed(_)
    ));
}

#[test]
fn sem_hash_a_fonte_nem_e_chamada() {
    let source = fake(&[]);
    let items = vec![raw_item_from_value(&json!({ "title": "Sem hash" }))];
    let _ = apply_file_evidence(Some(&source), &items);
    assert!(source.asked.lock().unwrap().is_empty());
}
