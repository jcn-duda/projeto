//! Testes da fila de auditoria (`audit.rs`). Casos portados de
//! `test/catalog-audit.test.ts`: a fila (`rows_needing_audit`), o carimbo
//! durável (`mark_audited*`), a prova medida em arquivo que não se perde no
//! rescan (`note_audit` + `scan`) e o reenfileiramento (`requeue_audit`).

use std::collections::HashMap;

use super::*;
use crate::rows::CatalogStore;
use crate::scan::scan_tests::{
    magnet, no_evidence, run, run_with, unknown_status, ACCOUNT, ADAPTER, EN_GROUPS, HASH_A,
    HASH_B, PT_MARKERS,
};
use crate::scan::{row, CatalogRowView, FileEvidence};

const LISTS: AuditLists<'static> = AuditLists {
    pt_markers: PT_MARKERS,
    en_groups: EN_GROUPS,
};

const ENG: &str = "Some English Movie 2020 1080p";
const ENG2: &str = "Another English 2021 1080p";
const ENG3: &str = "Third English 2022 1080p";
const DUAL: &str = "Outro 2022 Dual 720p";

fn get(s: &CatalogStore, id: &str) -> CatalogRowView {
    row(s, ADAPTER, ACCOUNT, id).unwrap().unwrap()
}

fn pt(s: &CatalogStore, id: &str) -> String {
    get(s, id).pt_proof
}

fn fc(s: &CatalogStore, id: &str) -> String {
    get(s, id).foreign_proof
}

fn aud(s: &CatalogStore, id: &str) -> i64 {
    get(s, id).audited_at
}

fn queue(s: &CatalogStore, ev: &dyn Fn(&str) -> Option<FileEvidence>) -> Vec<String> {
    let targets = rows_needing_audit(s, ADAPTER, ACCOUNT, None, ev).unwrap();
    targets.into_iter().map(|t| t.service_id).collect()
}

fn queued(s: &CatalogStore, id: &str) -> bool {
    queue(s, &no_evidence).iter().any(|x| x == id)
}

fn file(path: &str) -> AuditFile {
    AuditFile {
        path: Some(path.to_string()),
    }
}

fn audit(s: &CatalogStore, id: &str, path: &str, now: i64) {
    note_audit(s, ADAPTER, ACCOUNT, id, &[file(path)], now, &LISTS).unwrap();
}

fn mark(s: &CatalogStore, id: &str, now: i64) {
    mark_audited(s, ADAPTER, ACCOUNT, id, now).unwrap();
}

/// Evidência de arquivo que existe só para `hash`.
fn ev_for(hash: &str, a: &str, n: &str) -> impl Fn(&str) -> Option<FileEvidence> {
    let (hash, a, n) = (hash.to_string(), a.to_string(), n.to_string());
    move |h: &str| {
        (h == hash).then(|| FileEvidence {
            a: a.clone(),
            n: n.clone(),
        })
    }
}

#[test]
fn fila_pula_quem_ja_tem_evidencia_e_pega_o_dual() {
    let s = CatalogStore::open_memory().unwrap();
    let hash_c = "c".repeat(40);
    let m1 = magnet("1", HASH_A, "Filme 2024 Dublado 1080p");
    let m2 = magnet("2", HASH_B, ENG);
    let m3 = magnet("3", &hash_c, DUAL);
    run(&s, &[m1, m2, m3], 1000);
    // '2' já tem evidência de arquivo: não pode voltar à fila.
    let ids = queue(&s, &ev_for(HASH_B, "Dual", "Some English 2020.mkv"));
    assert!(
        !ids.iter().any(|x| x == "2"),
        "quem já tem evidência é pulado"
    );
    assert!(ids.iter().any(|x| x == "3"), "o dual entra na fila");
    assert!(
        !ids.iter().any(|x| x == "1"),
        "dublado com título não é fraco"
    );
}

#[test]
fn note_audit_path_dublado_absolve_e_rarbg_condena_com_cena() {
    let s = CatalogStore::open_memory().unwrap();
    let m1 = magnet("1", HASH_A, ENG);
    let m2 = magnet("2", HASH_B, "Another Foreign 2021 1080p");
    run(&s, &[m1, m2], 1000);
    audit(&s, "1", "dir/Filme.DUBLADO.mkv", 2000);
    assert_eq!(pt(&s, "1"), "arquivo");
    assert_eq!(fc(&s, "1"), "");

    audit(&s, "2", "dir/Movie.2021.RARBG.mkv", 2000);
    assert_eq!(fc(&s, "2"), "cena");
    assert_eq!(pt(&s, "2"), "");
}

#[test]
fn fila_drena_sem_depender_de_evidence_magnet_so_srt_nao_revisita() {
    // Torrent só com .srt: não há vídeo, logo não há `FileEvidence`. O marcador
    // durável `audited_at` é o que tira a linha da fila.
    let s = CatalogStore::open_memory().unwrap();
    let m1 = magnet("1", &"1a".repeat(20), ENG);
    let m2 = magnet("2", &"2b".repeat(20), DUAL);
    run(&s, &[m1, m2], 1000);
    assert!(queued(&s, "1") && queued(&s, "2"));

    audit(&s, "1", "Subs/Foo.srt", 2000);
    mark(&s, "2", 2000);
    assert!(!queued(&s, "1"), "auditoria sem vídeo drena a linha 1");
    assert!(!queued(&s, "2"), "mark_audited drena a linha 2");
}

#[test]
fn mark_audited_nao_muda_classificacao_e_nao_redata() {
    let s = CatalogStore::open_memory().unwrap();
    run(&s, &[magnet("1", HASH_A, "Filme 2024 Dublado 1080p")], 1000);
    let pre = get(&s, "1");
    mark(&s, "1", 2000);
    let pos = get(&s, "1");
    assert_eq!(pos.bucket, pre.bucket);
    assert_eq!(pos.foreign_proof, pre.foreign_proof);
    assert_eq!(pos.pt_proof, pre.pt_proof);
    assert_eq!(pos.audited_at, 2000, "auditedAt carimbado");

    mark(&s, "1", 3000);
    assert_eq!(aud(&s, "1"), 2000, "segunda chamada é no-op");
}

#[test]
fn fila_ignora_nao_prontos_e_lista_os_prontos() {
    let s = CatalogStore::open_memory().unwrap();
    let mut baixando = magnet("1", &"3c".repeat(20), ENG);
    baixando.ready = false;
    baixando.status = "Downloading".to_string();
    let pronto = magnet("2", &"4d".repeat(20), DUAL);
    run(&s, &[baixando, pronto], 1000);
    assert!(!queued(&s, "1"), "não-pronto nunca entra na fila");
    assert!(queued(&s, "2"), "pronto e fraco entra na fila");
}

#[test]
fn prova_por_titulo_nao_congela_no_rescan() {
    // Um rescan com título de condenação revoga a absolvição só pelo título,
    // mesmo com `audited_at` já carimbado: 'titulo' não é prova de arquivo.
    let s = CatalogStore::open_memory().unwrap();
    let h = "77".repeat(20);
    let dub = magnet("1", &h, "Nome do Filme Dublado 2024 1080p");
    run(&s, &[dub], 1000);
    assert_eq!(pt(&s, "1"), "titulo");

    mark(&s, "1", 2000);
    assert_eq!(aud(&s, "1"), 2000);

    let rarbg = magnet("1", &h, "Movie.Foreign.2023.1080p.x264-RARBG");
    run(&s, &[rarbg], 3000);
    assert_eq!(pt(&s, "1"), "", "absolvição por título é revogada");
    assert_eq!(fc(&s, "1"), "cena", "a condenação pelo rescan entra");
    assert_eq!(aud(&s, "1"), 2000, "o carimbo não regride (max)");
}

#[test]
fn prova_de_arquivo_sobrevive_quando_o_rescan_perde_a_evidencia() {
    let s = CatalogStore::open_memory().unwrap();
    let name = "Some.Movie.2024.1080p.WEB.x264";
    run(&s, &[magnet("1", HASH_A, name)], 1000);
    assert_eq!(
        pt(&s, "1"),
        "",
        "sem evidência, o título não grava 'arquivo'"
    );

    audit(&s, "1", "Filme/Filme DUBLADO 1080p.mkv", 2000);
    assert_eq!(pt(&s, "1"), "arquivo");

    // Rescan sem evidência: o título não vence a prova medida no arquivo.
    run(&s, &[magnet("1", HASH_A, name)], 3000);
    assert_eq!(
        pt(&s, "1"),
        "arquivo",
        "título nunca vence a prova do arquivo"
    );
    assert_eq!(
        aud(&s, "1"),
        2000,
        "scan sem evidência não re-data o carimbo"
    );
    assert!(!queued(&s, "1"), "absolvida não volta à fila");
}

#[test]
fn prova_de_arquivo_preserva_condenacao_por_arquivo() {
    let s = CatalogStore::open_memory().unwrap();
    run(&s, &[magnet("1", HASH_A, ENG)], 1000);
    assert_eq!(fc(&s, "1"), "", "precondição: sem condenação");

    audit(&s, "1", "Movie/Movie.1080p.x264-RARBG.mkv", 2000);
    assert_eq!(fc(&s, "1"), "cena");
    assert_eq!(aud(&s, "1"), 2000);

    run(&s, &[magnet("1", HASH_A, ENG)], 3000);
    assert_eq!(
        fc(&s, "1"),
        "cena",
        "título nunca apaga a condenação do arquivo"
    );
    assert_eq!(
        aud(&s, "1"),
        2000,
        "scan sem evidência não re-data o carimbo"
    );
    assert!(!queued(&s, "1"));
}

#[test]
fn evidencia_viva_sobrescreve_condenacao_congelada() {
    let s = CatalogStore::open_memory().unwrap();
    run(&s, &[magnet("1", HASH_A, ENG)], 1000);
    audit(&s, "1", "Movie/Movie.1080p.x264-RARBG.mkv", 2000);
    assert_eq!(fc(&s, "1"), "cena", "precondição: condenada por arquivo");

    // O scan agora VÊ evidência real que absolve.
    let ev = ev_for(HASH_A, "Dublado", "Filme/Filme DUBLADO 1080p.mkv");
    let empty = HashMap::new();
    let m = [magnet("1", HASH_A, "filme qualquer 2020 1080p")];
    run_with(&s, &m, 3000, &empty, &ev, &unknown_status);
    assert_eq!(pt(&s, "1"), "arquivo", "a prova nova (arquivo) absolve");
    assert_eq!(fc(&s, "1"), "", "a condenação congelada cede");
    assert_eq!(
        aud(&s, "1"),
        3000,
        "este scan viu evidência: a prova nova vence"
    );
}

#[test]
fn nao_congela_condenacao_por_titulo_e_drena_o_unknown() {
    let s = CatalogStore::open_memory().unwrap();
    let condenado = "f0".repeat(20);
    let desconhecido = "f1".repeat(20);

    // Condenado SÓ PELO TÍTULO, ainda não auditado.
    run(
        &s,
        &[magnet("1", &condenado, "Foreign.2024.RARBG.1080p.x264")],
        1000,
    );
    assert_eq!(fc(&s, "1"), "cena", "precondição: título condena");
    assert_eq!(aud(&s, "1"), 0);
    assert!(queued(&s, "1"), "precondição: na fila");

    // Sem arquivos: não carimba, porque os arquivos reais ainda podem absolver.
    mark_audited_unless_condemned(&s, ADAPTER, ACCOUNT, "1", 2000).unwrap();
    assert_eq!(aud(&s, "1"), 0, "condenado não é carimbado");
    assert!(queued(&s, "1"), "continua na fila");

    // Contra-caso: sem condenação, drena.
    run(&s, &[magnet("2", &desconhecido, ENG)], 1000);
    assert_eq!(fc(&s, "2"), "");
    mark_audited_unless_condemned(&s, ADAPTER, ACCOUNT, "2", 2000).unwrap();
    assert_eq!(aud(&s, "2"), 2000, "unknown drena: carimbado");
    assert!(!queued(&s, "2"));
}

#[test]
fn requeue_devolve_a_fila_so_quem_perdeu_a_evidencia() {
    // `upsert_row` mantém `audited_at` com max, então quem perdeu a evidência
    // ficaria fora da fila para sempre. Quem ainda tem evidência é preservado.
    let s = CatalogStore::open_memory().unwrap();
    let m1 = magnet("1", &"e1".repeat(20), ENG);
    let m2 = magnet("2", &"e2".repeat(20), DUAL);
    run(&s, &[m1, m2], 1000);
    let ev = ev_for(&"e2".repeat(20), "Dual", "Outro.2022.mkv");
    mark(&s, "1", 2000);
    mark(&s, "2", 2000);
    assert!(queue(&s, &ev).is_empty(), "precondição: fila drenada");

    let res = requeue_audit(&s, ADAPTER, ACCOUNT, None, &ev).unwrap();
    assert_eq!(res.requeued, 1, "só a linha sem evidência volta");
    assert_eq!(
        res.kept_with_evidence, 1,
        "a com evidência viva é preservada"
    );
    assert_eq!(res.already_queued, 0);
    assert_eq!(queue(&s, &ev), vec!["1".to_string()]);
}

#[test]
fn requeue_nao_apaga_as_provas_ja_medidas_em_arquivo() {
    // Limpar a prova abriria uma janela em que a linha valeria só pelo título.
    let s = CatalogStore::open_memory().unwrap();
    run(&s, &[magnet("1", &"e3".repeat(20), ENG)], 1000);
    audit(&s, "1", "dir/Filme.DUBLADO.mkv", 2000);
    assert_eq!(pt(&s, "1"), "arquivo", "precondição: absolvido por arquivo");

    requeue_audit(&s, ADAPTER, ACCOUNT, None, &no_evidence).unwrap();
    assert_eq!(pt(&s, "1"), "arquivo", "a absolvição medida sobrevive");
    assert_eq!(get(&s, "1").deleted_at, 0);
}

#[test]
fn requeue_respeita_o_teto_e_o_resto_fica_fora_da_fila() {
    let s = CatalogStore::open_memory().unwrap();
    let m1 = magnet("1", &"1a".repeat(20), ENG);
    let m2 = magnet("2", &"2b".repeat(20), ENG2);
    let m3 = magnet("3", &"3c".repeat(20), ENG3);
    run(&s, &[m1, m2, m3], 1000);
    for id in ["1", "2", "3"] {
        mark(&s, id, 2000);
    }
    let res = requeue_audit(&s, ADAPTER, ACCOUNT, Some(2), &no_evidence).unwrap();
    assert_eq!(res.requeued, 2, "para no teto");
    assert_eq!(queue(&s, &no_evidence).len(), 2);
}

#[test]
fn requeue_ignora_tombstone_e_conta_o_ja_enfileirado() {
    let s = CatalogStore::open_memory().unwrap();
    let m1 = magnet("1", HASH_A, ENG);
    let m2 = magnet("2", HASH_B, ENG2);
    let m3 = magnet("3", &"3c".repeat(20), ENG3);
    run(&s, &[m1, m2, m3], 1000);
    mark(&s, "1", 2000);
    mark(&s, "2", 2000);
    // O "2" sai da conta: vira tombstone e não entra em nenhum contador.
    let k1 = magnet("1", HASH_A, ENG);
    let k3 = magnet("3", &"3c".repeat(20), ENG3);
    run(&s, &[k1, k3], 3000);
    let res = requeue_audit(&s, ADAPTER, ACCOUNT, None, &no_evidence).unwrap();
    assert_eq!(res.requeued, 1, "só o '1' audited sem evidência volta");
    assert_eq!(res.already_queued, 1, "o '3' já estava na fila");
    assert_eq!(res.kept_with_evidence, 0);
}

#[test]
fn fila_com_teto_e_zero_reproduz_o_ts_que_devolve_um() {
    // O TS põe o `break` DEPOIS do push: `limit = 0` com candidato devolve 1.
    // Preservado para não mexer na fila; a diferença está no relatório da porte.
    let s = CatalogStore::open_memory().unwrap();
    let m1 = magnet("1", &"1a".repeat(20), ENG);
    let m2 = magnet("2", &"2b".repeat(20), ENG2);
    run(&s, &[m1, m2], 1000);
    assert_eq!(queue(&s, &no_evidence).len(), 2, "sem teto, todos");
    let um = rows_needing_audit(&s, ADAPTER, ACCOUNT, Some(1), &no_evidence);
    assert_eq!(um.unwrap().len(), 1);
    let zero = rows_needing_audit(&s, ADAPTER, ACCOUNT, Some(0), &no_evidence);
    assert_eq!(zero.unwrap().len(), 1, "teto 0 devolve 1, como o TS");
}

#[test]
fn note_audit_sem_linha_nao_faz_nada() {
    let s = CatalogStore::open_memory().unwrap();
    audit(&s, "nada", "Filme DUBLADO.mkv", 1000);
    assert_eq!(row(&s, ADAPTER, ACCOUNT, "nada").unwrap(), None);
}
