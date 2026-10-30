//! Provas de `file_sizes` sobre `NativeKv::open_memory()`: filtro da régua do
//! TS, normalização do hash, round-trip, total inválido, vencido e poda.

use adom_core::DebridFile;
use adom_index::NativeKv;

use super::{
    files_key, read_files, read_totals, record_files, record_total, total_key,
    FILE_SIZES_TTL_SECONDS,
};

const NOW: i64 = 1_700_000_000_000;
const HASH: &str = "ABCDEF0123456789abcdef0123456789abcdef01";
const HASH_LOWER: &str = "abcdef0123456789abcdef0123456789abcdef01";

fn file(path: &str, size: f64) -> DebridFile {
    DebridFile {
        path: path.to_string(),
        size,
    }
}

fn kv() -> NativeKv {
    NativeKv::open_memory().expect("KV em memória")
}

#[test]
fn chaves_sao_minusculas_e_com_prefixo_do_node() {
    assert_eq!(files_key(HASH), format!("fsz:v1:{HASH_LOWER}"));
    assert_eq!(total_key(HASH), format!("tsz:v1:{HASH_LOWER}"));
    assert_eq!(FILE_SIZES_TTL_SECONDS, 2_592_000);
}

#[test]
fn filtra_sample_anuncio_nao_video_e_tamanho_zero() {
    let kv = kv();
    let files = vec![
        file("Pasta/Filme.Real.mkv", 4_000.0),
        file("Pasta/Filme.Sample.mkv", 9_000.0),
        file("1XBET.COM_promo.mp4", 8_000.0),
        file("Pasta/leia-me.txt", 7_000.0),
        file("Pasta/zero.mkv", 0.0),
    ];
    assert!(record_files(&kv, HASH, &files, NOW).unwrap());

    let read = read_files(&kv, &[HASH.to_string()], NOW);
    let list = read.get(HASH_LOWER).expect("hash lido em minúsculas");
    assert_eq!(list, &vec![file("Pasta/Filme.Real.mkv", 4_000.0)]);
}

#[test]
fn lista_vazia_apos_filtro_nao_grava() {
    let kv = kv();
    let files = vec![file("leia-me.txt", 10.0), file("Pasta/zero.mkv", 0.0)];
    assert!(!record_files(&kv, HASH, &files, NOW).unwrap());
    assert!(read_files(&kv, &[HASH.to_string()], NOW).is_empty());
}

#[test]
fn hash_vazio_nao_grava_nada() {
    let kv = kv();
    assert!(!record_files(&kv, "  ", &[file("a.mkv", 1.0)], NOW).unwrap());
    assert!(!record_total(&kv, "", 10.0, NOW).unwrap());
}

#[test]
fn total_round_trip_e_chave_minuscula() {
    let kv = kv();
    assert!(record_total(&kv, HASH, 12_345_678.0, NOW).unwrap());
    let totals = read_totals(&kv, &[HASH.to_string()], NOW);
    assert_eq!(totals.get(HASH_LOWER), Some(&12_345_678.0));
}

#[test]
fn total_invalido_nao_grava() {
    let kv = kv();
    for bytes in [0.0, -5.0, f64::NAN, f64::INFINITY] {
        assert!(!record_total(&kv, HASH, bytes, NOW).unwrap(), "{bytes}");
    }
    assert!(read_totals(&kv, &[HASH.to_string()], NOW).is_empty());
}

#[test]
fn vencido_nao_volta_na_leitura() {
    let kv = kv();
    assert!(record_total(&kv, HASH, 100.0, NOW).unwrap());
    assert!(record_files(&kv, HASH, &[file("a.mkv", 5.0)], NOW).unwrap());
    let depois = NOW + (FILE_SIZES_TTL_SECONDS + 1) * 1_000;
    assert!(read_totals(&kv, &[HASH.to_string()], depois).is_empty());
    assert!(read_files(&kv, &[HASH.to_string()], depois).is_empty());
}

#[test]
fn hashes_duplicados_sao_lidos_uma_vez() {
    let kv = kv();
    assert!(record_total(&kv, HASH, 7.0, NOW).unwrap());
    let hashes = vec![HASH.to_string(), HASH_LOWER.to_string()];
    let totals = read_totals(&kv, &hashes, NOW);
    assert_eq!(totals.len(), 1);
}

#[test]
fn poda_remove_so_o_vencido_do_namespace() {
    let kv = kv();
    assert!(record_total(&kv, HASH, 100.0, NOW).unwrap());
    assert!(record_files(&kv, "outro", &[file("a.mkv", 5.0)], NOW).unwrap());
    let depois = NOW + (FILE_SIZES_TTL_SECONDS + 1) * 1_000;
    assert_eq!(kv.prune_expired("tsz:v1:", depois).unwrap(), 1);
    assert_eq!(kv.prune_expired("fsz:v1:", depois).unwrap(), 1);
    assert_eq!(kv.prune_expired("fsz:v1:", depois).unwrap(), 0);
}
