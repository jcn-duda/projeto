//! Testes do pedido de lista de arquivos (`file_wants.rs`) e do ponto em que o
//! build o entrega ao debrid (`want_files` antes de `prepare`).

use std::collections::BTreeMap;

use adom_core::{DebridFile, RankingStream, UNKNOWN_QUALITY};

use super::file_wants::pack_hashes_missing_files;
use super::finalize::finalize_streams;
use super::tests::test_common::base_ctx;
use super::types::{BuildOptions, BuiltList, DebridAnswer, DebridCheck};

const H1: &str = "aa01000000000000000000000000000000000001";
const H2: &str = "aa02000000000000000000000000000000000002";

/// Episódio avulso, com tamanho e resolução: o caso que NÃO pede a lista.
fn episodio(title: &str, hash: &str) -> RankingStream {
    RankingStream {
        info_hash: Some(hash.into()),
        title: Some(title.into()),
        quality: Some("1080p".into()),
        size: Some(1.5e9),
        bytes: Some(1.5e9),
        ..RankingStream::default()
    }
}

fn sem_known() -> BTreeMap<String, Vec<DebridFile>> {
    BTreeMap::new()
}

#[test]
fn pack_de_temporada_entra() {
    let s = episodio("Serie Teste Temporada Completa 1080p", H1);
    let out = pack_hashes_missing_files(&[s], Some(1), &sem_known());
    assert_eq!(out, vec![H1.to_string()]);
}

#[test]
fn episodio_avulso_com_tamanho_e_qualidade_nao_entra() {
    let s = episodio("Serie Teste S01E02 1080p", H1);
    let out = pack_hashes_missing_files(&[s], Some(1), &sem_known());
    assert!(out.is_empty(), "avulso medido não pede lista: {out:?}");
}

#[test]
fn episodio_sem_tamanho_entra() {
    let mut s = episodio("Serie Teste S01E02 1080p", H1);
    s.size = None;
    s.bytes = None;
    let out = pack_hashes_missing_files(&[s], Some(1), &sem_known());
    assert_eq!(out, vec![H1.to_string()]);
}

#[test]
fn tamanho_zerado_conta_como_sem_tamanho() {
    let mut s = episodio("Serie Teste S01E02 1080p", H1);
    s.size = Some(0.0);
    s.bytes = Some(-1.0);
    let out = pack_hashes_missing_files(&[s], Some(1), &sem_known());
    assert_eq!(out, vec![H1.to_string()]);
}

#[test]
fn sem_resolucao_entra() {
    let mut s = episodio("Serie Teste S01E02", H1);
    s.quality = Some(UNKNOWN_QUALITY.into());
    let out = pack_hashes_missing_files(&[s], Some(1), &sem_known());
    assert_eq!(out, vec![H1.to_string()]);
}

#[test]
fn qualidade_ausente_nao_conta_como_sem_resolucao() {
    // O TS só olhava o rótulo explícito: `None` não pede a lista.
    let mut s = episodio("Serie Teste S01E02", H1);
    s.quality = None;
    let out = pack_hashes_missing_files(&[s], Some(1), &sem_known());
    assert!(out.is_empty(), "{out:?}");
}

#[test]
fn multiobra_em_filme_entra() {
    let s = RankingStream {
        multi_work: Some(true),
        ..episodio("Colecao Teste Trilogia 1080p", H1)
    };
    let out = pack_hashes_missing_files(&[s], None, &sem_known());
    assert_eq!(out, vec![H1.to_string()]);
}

#[test]
fn filme_comum_com_tamanho_nao_entra() {
    let s = episodio("Filme Teste 2024 1080p", H1);
    let out = pack_hashes_missing_files(&[s], None, &sem_known());
    assert!(out.is_empty(), "{out:?}");
}

#[test]
fn faixa_multi_episodio_nomeada_entra() {
    let s = episodio("Serie Teste S01E01-E08 1080p", H1);
    let out = pack_hashes_missing_files(&[s], Some(1), &sem_known());
    assert_eq!(out, vec![H1.to_string()]);
}

#[test]
fn hash_ja_conhecido_sai() {
    let s = episodio("Serie Teste Temporada Completa 1080p", H1);
    let mut known = BTreeMap::new();
    known.insert(
        H1.to_string(),
        vec![DebridFile {
            path: "a.mkv".into(),
            size: 1.0,
        }],
    );
    let out = pack_hashes_missing_files(&[s], Some(1), &known);
    assert!(out.is_empty());
}

#[test]
fn duplicata_sai_e_ordem_da_primeira_aparicao_fica() {
    let a = episodio("Serie Teste Temporada Completa 1080p", H2);
    let b = episodio("Serie Teste Temporada Completa 720p", H1);
    let dup = episodio("Serie Teste Temporada Completa 2160p", H2);
    let out = pack_hashes_missing_files(&[a, b, dup], Some(1), &sem_known());
    assert_eq!(out, vec![H2.to_string(), H1.to_string()]);
}

#[test]
fn hash_maiusculo_vira_minusculo() {
    let s = episodio("Serie Teste Temporada Completa 1080p", &H1.to_uppercase());
    let out = pack_hashes_missing_files(&[s], Some(1), &sem_known());
    assert_eq!(out, vec![H1.to_string()]);
}

#[test]
fn stream_sem_hash_sai() {
    let mut s = episodio("Serie Teste Temporada Completa 1080p", H1);
    s.info_hash = Some(String::new());
    let mut sem = episodio("Serie Teste Temporada Completa 1080p", H1);
    sem.info_hash = None;
    let out = pack_hashes_missing_files(&[s, sem], Some(1), &sem_known());
    assert!(out.is_empty());
}

/// Debrid de teste que grava a ORDEM das chamadas e os hashes pedidos.
#[derive(Default)]
struct RecordingDebrid {
    events: Vec<&'static str>,
    wanted: Vec<String>,
}

impl DebridCheck for RecordingDebrid {
    fn check(&mut self, _stream: &RankingStream) -> DebridAnswer {
        DebridAnswer::Unknown
    }
    fn want_files(&mut self, hashes: &[String]) {
        self.events.push("want_files");
        self.wanted = hashes.to_vec();
    }
    fn prepare(&mut self, _hashes: &[String]) {
        self.events.push("prepare");
    }
}

#[test]
fn build_pede_os_arquivos_do_pack_antes_do_prepare() {
    let mut ctx = base_ctx();
    ctx.season = Some(1);
    let opts = BuildOptions::default();
    let streams = vec![episodio("Serie Teste Temporada Completa 1080p", H1)];
    let mut debrid = RecordingDebrid::default();
    let mut out = BuiltList::default();
    finalize_streams(streams, &ctx, &opts, &mut debrid, &mut out);
    assert_eq!(debrid.events, vec!["want_files", "prepare"]);
    assert_eq!(debrid.wanted, vec![H1.to_string()]);
}

#[test]
fn build_sem_candidato_que_pede_arquivos_nao_chama_want_files() {
    let mut ctx = base_ctx();
    ctx.season = Some(1);
    let opts = BuildOptions::default();
    let streams = vec![episodio("Serie Teste S01E02 1080p", H1)];
    let mut debrid = RecordingDebrid::default();
    let mut out = BuiltList::default();
    finalize_streams(streams, &ctx, &opts, &mut debrid, &mut out);
    assert_eq!(debrid.events, vec!["prepare"]);
}
