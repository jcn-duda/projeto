//! Testes da abertura com `quick_check` + quarentena (fatia T1-A3).
//!
//! O caso real: queda de energia deixa o `streams.db` truncado. O `open` antigo
//! morria no `CREATE TABLE` ("database disk image is malformed") e o addon não
//! subia; aqui o arquivo podre é afastado, o schema nasce de novo e quem lê o
//! store enxerga um cache vazio em vez de um serviço fora do ar.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::{open_quarantined, open_read_only_checked, OpenReport};
use crate::streams::{read_row, StreamsStore};

const LIXO: &[u8] = b"not a database";

fn arquivo_podre(dir: &Path, nome: &str) -> PathBuf {
    let path = dir.join(nome);
    std::fs::write(&path, LIXO).expect("grava o arquivo corrompido");
    path
}

/// Nomes no diretório que casam `<arquivo>.corrupt-<epoch>` (+ sidecars).
fn quarentenados(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .expect("lista o diretório")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".corrupt-"))
        .collect();
    out.sort();
    out
}

#[test]
fn open_com_arquivo_corrompido_quarentena_e_recria() {
    let dir = tempfile::tempdir().unwrap();
    let path = arquivo_podre(dir.path(), "streams.db");

    let store = StreamsStore::open(&path).expect("abre mesmo com o arquivo podre");

    let movidos = quarentenados(dir.path());
    assert_eq!(movidos.len(), 1, "um arquivo em quarentena: {movidos:?}");
    assert!(
        movidos[0].starts_with("streams.db.corrupt-"),
        "mesmo diretório, mesma base: {movidos:?}"
    );
    // O store recriado responde — vazio, mas responde.
    assert!(store
        .get("streams:v21:movie:tt1:scope", 1_000)
        .unwrap()
        .is_none());
    assert!(path.exists(), "o arquivo NOVO está no caminho original");
}

#[test]
fn quarentena_preserva_o_conteudo_original() {
    let dir = tempfile::tempdir().unwrap();
    let path = arquivo_podre(dir.path(), "streams.db");

    let _ = StreamsStore::open(&path).expect("abre degradado");
    let movidos = quarentenados(dir.path());
    let bytes = std::fs::read(dir.path().join(&movidos[0])).unwrap();
    assert_eq!(bytes, LIXO, "nada é apagado sem cópia");
}

#[test]
fn streams_degradado_expoe_o_motivo() {
    let dir = tempfile::tempdir().unwrap();
    let path = arquivo_podre(dir.path(), "streams.db");

    let store = StreamsStore::open(&path).expect("abre degradado");
    assert!(store.degraded(), "o painel precisa saber que o cache caiu");
    let err = store.degraded_error().expect("motivo registrado");
    assert!(err.contains("quick_check"), "motivo do veredito: {err}");
    assert!(err.contains("corrupt-"), "destino do arquivo: {err}");
}

#[test]
fn abrir_banco_novo_nao_e_degradado() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("streams.db");

    let store = StreamsStore::open(&path).unwrap();
    assert!(!store.degraded());
    assert!(store.degraded_error().is_none());
    assert!(quarentenados(dir.path()).is_empty());
}

#[test]
fn banco_saudavel_reabre_sem_quarentena() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("streams.db");
    {
        let store = StreamsStore::open(&path).unwrap();
        store
            .set("streams:v21:movie:tt1:scope", &entry(), 600, 1_000)
            .unwrap();
    }
    let store = StreamsStore::open(&path).unwrap();
    assert!(!store.degraded(), "arquivo íntegro não é quarentenado");
    assert!(store
        .get("streams:v21:movie:tt1:scope", 1_001)
        .unwrap()
        .is_some());
}

#[test]
fn open_quarantined_devolve_conexao_utilizavel_e_o_relatorio() {
    let dir = tempfile::tempdir().unwrap();
    let path = arquivo_podre(dir.path(), "x.db");

    let (conn, report): (Connection, OpenReport) =
        open_quarantined(&path, "CREATE TABLE IF NOT EXISTS t (x INTEGER);").unwrap();
    assert!(report.degraded);
    assert!(report.error.is_some());
    conn.execute("INSERT INTO t (x) VALUES (1)", []).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn read_row_devolve_none_no_miss_e_propaga_erro_real() {
    let dir = tempfile::tempdir().unwrap();
    let path = arquivo_podre(dir.path(), "dinamico.db");
    let schema = "CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    );";
    let (conn, _) = open_quarantined(&path, schema).unwrap();

    // Miss legítimo: tabela existe, chave não.
    assert!(read_row(&conn, "streams:v21:movie:tt1:scope")
        .unwrap()
        .is_none());

    // Erro real (esquema errado): NÃO pode virar "miss" silencioso.
    let outro = Connection::open_in_memory().unwrap();
    outro
        .execute_batch("CREATE TABLE IF NOT EXISTS outra (x INTEGER);")
        .unwrap();
    let err = read_row(&outro, "streams:v21:movie:tt1:scope").expect_err("erro propagado");
    assert!(err.contains("ler"), "mensagem do erro: {err}");
}

#[test]
fn read_only_degradado_nao_renomeia_o_arquivo_do_dono() {
    // `cache.db` do Node: o dono da escrita é outro processo. Renomear aqui
    // deixaria o Node gravando num inode órfão — o veredito basta.
    let dir = tempfile::tempdir().unwrap();
    let path = arquivo_podre(dir.path(), "cache.db");

    let (_conn, report) = open_read_only_checked(&path).expect("abre read-only mesmo podre");
    assert!(report.degraded);
    let err = report.error.expect("motivo registrado");
    assert!(err.contains("não foi movido"), "motivo: {err}");
    assert!(path.exists(), "o arquivo do dono fica onde está");
    assert!(quarentenados(dir.path()).is_empty());
}

fn entry() -> adom_search::StreamsEntry {
    adom_search::StreamsEntry {
        streams: vec![adom_search::StreamItem {
            info_hash: Some("0123456789abcdef0123456789abcdef01234567".into()),
            ..adom_search::StreamItem::default()
        }],
        debrid_known: Some(true),
        ..Default::default()
    }
}
