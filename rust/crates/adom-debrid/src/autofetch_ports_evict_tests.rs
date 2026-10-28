//! Evicção por hash: só a AllDebrid sai do `Unsupported`, com prova.
//!
//! As envs ficam presas durante TODO o teste por [`EvictEnv`]: `with_env` do
//! módulo pai não é reentrante (o `Mutex` do `test_env` trava na segunda
//! chamada), então base, kill-switch e teto são ajustados de uma vez e
//! restaurados no `Drop`. Nenhum teste depende de ordem.

use std::path::PathBuf;
use std::sync::MutexGuard;

use super::*;
use crate::alldebrid_cleanup::{account_scope, adprot_key, adsub_key};
use crate::autofetch_ports::evict::{evict_enabled_from, max_per_call_from, EVICT_ENV};

/// Envs da evicção + base em loopback, presas até o fim do teste.
pub(super) struct EvictEnv {
    _lock: MutexGuard<'static, ()>,
    saved: Vec<(&'static str, Option<String>)>,
}

impl EvictEnv {
    pub(super) fn new(addr: SocketAddr, flag: &str) -> Self {
        let lock = crate::test_env::lock();
        let mut saved = Vec::new();
        Self::set("ALLDEBRID_API_BASE", &base(addr), &mut saved);
        Self::set(EVICT_ENV, flag, &mut saved);
        Self { _lock: lock, saved }
    }

    fn set(name: &'static str, value: &str, saved: &mut Vec<(&'static str, Option<String>)>) {
        saved.push((name, std::env::var(name).ok()));
        unsafe {
            std::env::set_var(name, value);
        }
    }
}

impl Drop for EvictEnv {
    fn drop(&mut self) {
        for (name, prev) in self.saved.drain(..) {
            unsafe {
                match prev {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

/// Data de expiração bem à frente: `alive` compara `expires_at > now`.
const FAR_FUTURE: i64 = 4_000_000_000_000;

/// Carimbo `at` do `adsub` (ms) na era do `uploadDate` de [`row`]: posse velha
/// e upload da mesma época, então margem/idade do caminho feliz passam.
const STAMP: i64 = 1_700_000_000_000;

/// `cache.db` do Node com as marcas que o teste precisa (`adsub`/`adprot`).
pub(super) fn db_with(keys: &[String]) -> (tempfile::TempDir, PathBuf) {
    db_with_at(keys, STAMP)
}

/// Mesmo banco com o `at` do `adsub` escolhido pelo teste (idade da posse).
pub(super) fn db_with_at(keys: &[String], at: i64) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
    )
    .unwrap();
    for key in keys {
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![key, format!("{{\"at\":{at}}}"), FAR_FUTURE],
        )
        .unwrap();
    }
    (dir, path)
}

/// Posse provada (`adsub:v1`) da chave de teste.
pub(super) fn owned(hash: &str) -> String {
    adsub_key(&account_scope(KEY), hash)
}

/// Retenção BR durável (`adprot:v1`) da chave de teste.
pub(super) fn retained(hash: &str) -> String {
    adprot_key(&account_scope(KEY), hash)
}

/// Linha da conta (`/magnet/status`) com id, hash e filename.
pub(super) fn row(id: u64, hash: &str, filename: &str) -> serde_json::Value {
    row_dated(id, hash, filename, 1_700_000_000)
}

/// Mesma linha com `uploadDate` em SEGUNDOS (a API manda segundos).
pub(super) fn row_dated(id: u64, hash: &str, filename: &str, upload_s: i64) -> serde_json::Value {
    json!({"id": id, "hash": hash, "filename": filename, "uploadDate": upload_s})
}

pub(super) fn all_debrid(db_path: PathBuf) -> AutofetchPorts {
    AutofetchPorts::alldebrid(
        Arc::new(AllDebrid::new(HttpClient::new().unwrap())),
        KEY,
        AlldebridFacts {
            db_path: Some(db_path),
            ..AlldebridFacts::default()
        },
    )
}

pub(super) fn paths(scene: &Scene) -> Vec<String> {
    scene
        .hits
        .lock()
        .unwrap()
        .iter()
        .map(|hit| hit.path.clone())
        .collect()
}

#[test]
fn kill_switch_precisa_da_env_e_do_global() {
    assert!(!evict_enabled_from(None, false), "sem env nasce OFF");
    assert!(!evict_enabled_from(Some("false"), false));
    assert!(!evict_enabled_from(Some(""), false));
    assert!(evict_enabled_from(Some("on"), false));
    assert!(evict_enabled_from(Some(" TRUE "), false));
    assert!(
        !evict_enabled_from(Some("on"), true),
        "o kill-switch da limpeza desliga por cima"
    );
}

#[test]
fn teto_por_chamada_so_aperta() {
    assert_eq!(max_per_call_from(None), 25);
    assert_eq!(max_per_call_from(Some("3")), 3);
    assert_eq!(max_per_call_from(Some(" 0 ")), 25, "zero não é teto");
    assert_eq!(max_per_call_from(Some("abc")), 25);
    assert_eq!(max_per_call_from(Some("999")), 25, "a env não solta o teto");
}

#[tokio::test]
async fn hash_fora_da_lista_nao_e_reportado_como_removido() {
    let (present, absent) = (hash_of('a'), hash_of('b'));
    let body = envelope(json!({"magnets": [row(11, &present, "Duna.2021.1080p.mkv")]}));
    let (addr, scene) = listen(
        vec![
            ("GET /magnet/status", 200, body),
            ("GET /magnet/delete", 200, envelope(json!({}))),
        ],
        (404, "{}".into()),
    )
    .await;
    let (_dir, db) = db_with(&[owned(&present)]);
    let _env = EvictEnv::new(addr, "on");
    let port = all_debrid(db);
    let removed = port
        .evict(&[present.clone(), absent.clone()])
        .await
        .unwrap();
    assert_eq!(removed, vec![present], "só o que tem id na lista sai");
    assert!(!removed.contains(&absent), "ausência não vira remoção");
    assert_eq!(paths(&scene), ["/magnet/status", "/magnet/delete"]);
}

#[tokio::test]
async fn falha_de_listagem_propaga_e_nao_vira_lista_vazia() {
    let hash = hash_of('c');
    let (_dir, db) = db_with(&[owned(&hash)]);
    // 1) erro de rede/serviço na listagem.
    let (addr, scene) = listen(vec![], (503, "{}".into())).await;
    {
        let _env = EvictEnv::new(addr, "on");
        let error = all_debrid(db.clone())
            .evict(std::slice::from_ref(&hash))
            .await
            .unwrap_err();
        assert_ne!(error.kind(), "unsupported", "a capacidade existe: {error}");
        assert_eq!(paths(&scene), ["/magnet/status"], "nenhum delete tentado");
    }
    // 2) 200 sem a lista: também é falha, não conta vazia.
    let (addr, scene) = listen(
        vec![("GET /magnet/status", 200, envelope(json!({"outro": 1})))],
        (404, "{}".into()),
    )
    .await;
    let _env = EvictEnv::new(addr, "on");
    assert!(all_debrid(db).evict(&[hash]).await.is_err());
    assert_eq!(paths(&scene), ["/magnet/status"]);
}

#[tokio::test]
async fn kill_switch_off_desliga_capacidade_sem_rede() {
    let hash = hash_of('d');
    let (addr, scene) = listen(vec![], (500, "{}".into())).await;
    let (_dir, db) = db_with(&[owned(&hash)]);
    let _env = EvictEnv::new(addr, "false");
    let port = all_debrid(db);
    assert!(
        !port.capabilities().evict,
        "capacidade ligada sem a env seria mentira"
    );
    assert_eq!(port.evict(&[hash]).await.unwrap_err().kind(), "unsupported");
    assert!(paths(&scene).is_empty(), "OFF = zero rede");
}

#[tokio::test]
async fn hash_protegido_nao_e_apagado() {
    let (keep, br, free) = (hash_of('e'), hash_of('f'), hash_of('9'));
    let body = envelope(json!({"magnets": [
        row(21, &keep, "Duna.2021.1080p.mkv"),
        row(22, &br, "Duna.2021.DUBLADO.1080p.mkv"),
        row(23, &free, "Duna.2021.2160p.mkv"),
    ]}));
    let (addr, scene) = listen(
        vec![
            ("GET /magnet/status", 200, body),
            ("GET /magnet/delete", 200, envelope(json!({}))),
        ],
        (404, "{}".into()),
    )
    .await;
    // Os três têm posse provada: só a guarda de proteção barra os dois.
    let (_dir, db) = db_with(&[owned(&keep), owned(&br), owned(&free), retained(&keep)]);
    let _env = EvictEnv::new(addr, "on");
    let port = all_debrid(db);
    let removed = port
        .evict(&[keep.clone(), br.clone(), free.clone()])
        .await
        .unwrap();
    assert_eq!(removed, vec![free], "retenção BR e nome dublado preservam");
    assert!(!removed.contains(&keep));
    assert!(!removed.contains(&br));
    assert_eq!(paths(&scene), ["/magnet/status", "/magnet/delete"]);
}

#[tokio::test]
async fn dois_hashes_do_mesmo_id_apagam_uma_vez() {
    let (first, second) = (hash_of('1'), hash_of('2'));
    let body = envelope(json!({"magnets": [
        row(31, &first, "Duna.2021.1080p.mkv"),
        row(31, &second, "Duna.2021.2160p.mkv"),
    ]}));
    let (addr, scene) = listen(
        vec![
            ("GET /magnet/status", 200, body),
            ("GET /magnet/delete", 200, envelope(json!({}))),
        ],
        (404, "{}".into()),
    )
    .await;
    let (_dir, db) = db_with(&[owned(&first), owned(&second)]);
    let _env = EvictEnv::new(addr, "on");
    let port = all_debrid(db);
    let removed = port.evict(&[first.clone(), second.clone()]).await.unwrap();
    assert_eq!(removed, vec![first], "um id, uma remoção");
    assert_eq!(paths(&scene), ["/magnet/status", "/magnet/delete"]);
}

#[tokio::test]
async fn nome_ausente_fecha_a_guarda() {
    let hash = hash_of('a');
    let body = envelope(json!({"magnets": [{"id": 41, "hash": hash}]}));
    let (addr, scene) = listen(
        vec![
            ("GET /magnet/status", 200, body),
            ("GET /magnet/delete", 200, envelope(json!({}))),
        ],
        (404, "{}".into()),
    )
    .await;
    let (_dir, db) = db_with(&[owned(&hash)]);
    let _env = EvictEnv::new(addr, "on");
    let port = all_debrid(db);
    assert!(port.capabilities().evict, "AllDebrid com a env ON");
    // Sem `filename` não há blindagem BR para conferir: ninguém sai.
    assert!(port.evict(&[hash]).await.unwrap().is_empty());
    assert_eq!(paths(&scene), ["/magnet/status"]);
}

#[tokio::test]
async fn sem_chave_ou_sem_banco_recusa_sem_apagar() {
    let hash = hash_of('b');
    let (addr, scene) = listen(vec![], (500, "{}".into())).await;
    let (_dir, db) = db_with(&[owned(&hash)]);
    let _env = EvictEnv::new(addr, "on");
    // Chave vazia: a taxonomia `auth` sobe, nada é listado nem apagado.
    let sem_chave = AutofetchPorts::alldebrid(
        Arc::new(AllDebrid::new(HttpClient::new().unwrap())),
        "",
        AlldebridFacts {
            db_path: Some(db),
            ..AlldebridFacts::default()
        },
    );
    assert_eq!(
        sem_chave
            .evict(std::slice::from_ref(&hash))
            .await
            .unwrap_err()
            .kind(),
        "auth"
    );
    // Sem `cache.db` a guarda durável não é legível: recusa, não apaga às cegas.
    let sem_banco = AutofetchPorts::alldebrid(
        Arc::new(AllDebrid::new(HttpClient::new().unwrap())),
        KEY,
        AlldebridFacts::default(),
    );
    let error = sem_banco.evict(&[hash]).await.unwrap_err();
    assert_ne!(error.kind(), "unsupported", "a capacidade existe: {error}");
    assert!(paths(&scene).is_empty(), "nenhuma chamada de rede");
}

#[tokio::test]
async fn os_outros_quatro_servicos_seguem_unsupported() {
    let (addr, scene) = listen(vec![], (500, "{}".into())).await;
    let rd = RdPorts::new(
        part2::realdebrid(addr),
        part2::gate(),
        Arc::new(part2::StoreSpy::default()),
    );
    let ports = [
        ("torbox", AutofetchPorts::torbox(torbox(addr), KEY)),
        (
            "premiumize",
            AutofetchPorts::premiumize(premiumize(addr), KEY),
        ),
        (
            "debridlink",
            AutofetchPorts::debridlink(Arc::new(DebridLink::new(HttpClient::new().unwrap())), KEY),
        ),
        ("realdebrid", AutofetchPorts::realdebrid(rd, KEY)),
    ];
    for (service, port) in ports {
        assert_eq!(
            port.evict(&[hash_of('a')]).await.unwrap_err().kind(),
            "unsupported",
            "{service}"
        );
        assert!(!port.capabilities().evict, "{service}");
    }
    assert!(paths(&scene).is_empty(), "capacidade OFF não faz I/O");
}
