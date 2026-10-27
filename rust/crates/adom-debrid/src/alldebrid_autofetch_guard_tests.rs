use super::super::{enqueue_decision, EnqueueDecision};
use super::*;

/// Instante fixo: a guarda é comparada por `expires_at > now_ms`, então o
/// relógio real não pode entrar nos testes.
const NOW: i64 = 1_000_000;

/// `cache.db` mínimo do Node, o mesmo schema que a checagem encontra em
/// produção: `key`/`value`/`expires_at` e `expires_at` explícito por chave.
fn cache_db(dir: &std::path::Path, rows: &[(String, i64)]) -> std::path::PathBuf {
    let path = dir.join("cache.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
    )
    .unwrap();
    for (key, expires_at) in rows {
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
            params![key, expires_at],
        )
        .unwrap();
    }
    path
}

#[test]
fn distingue_marca_viva_expirada_e_conta() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)").unwrap();
    conn.execute(
        "INSERT INTO cache VALUES (?1, '{}', ?2)",
        params![adrm_key("conta", "ABCD"), 1001],
    )
    .unwrap();
    assert!(read_adrm_block(&path, "conta", "abcd", 1000).unwrap());
    assert!(!read_adrm_block(&path, "conta", "abcd", 1001).unwrap());
    assert!(!read_adrm_block(&path, "outra", "abcd", 1000).unwrap());
}

#[test]
fn recusa_banco_ausente_tabela_ausente_e_linha_malformada() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("ausente.db");
    assert!(read_adrm_block(&missing, "conta", "hash", 0).is_err());
    assert!(!missing.exists());
    let path = dir.path().join("cache.db");
    let conn = Connection::open(&path).unwrap();
    assert!(read_adrm_block(&path, "conta", "hash", 0).is_err());
    conn.execute_batch("CREATE TABLE cache (key TEXT PRIMARY KEY, expires_at TEXT NOT NULL)")
        .unwrap();
    conn.execute(
        "INSERT INTO cache VALUES (?1, 'inválido')",
        params![adrm_key("conta", "hash")],
    )
    .unwrap();
    assert!(read_adrm_block(&path, "conta", "hash", 0).is_err());
    assert!(read_adrm_block(&path, "", "hash", 0).is_err());
}

#[test]
fn sem_marca_e_clear_com_e_sem_inventario() {
    // Só a chave de OUTRA conta existe: ausência de linha é prova de ausência
    // de marca, e inventário pronto não inventa bloqueio onde não há nada.
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(dir.path(), &[(adrm_key("outra", "abcd"), NOW + 60_000)]);
    assert_eq!(
        guard_evidence(&path, "conta", "abcd", false, NOW),
        ReuploadEvidence::Clear
    );
    assert_eq!(
        guard_evidence(&path, "conta", "abcd", true, NOW),
        ReuploadEvidence::Clear
    );
}

#[test]
fn marca_viva_e_blocked_ate_com_inventario_ausente() {
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(dir.path(), &[(adrm_key("conta", "abcd"), NOW + 60_000)]);
    assert_eq!(
        guard_evidence(&path, "conta", "ABCD", false, NOW),
        ReuploadEvidence::Blocked
    );
}

#[test]
fn marca_viva_com_inventario_pronto_e_blocked_but_inventory_ready() {
    // O hash já está na conta (inventário vivo): a marca não precisa mais
    // barrar, mas quem a limpa é o worker, nunca esta função.
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(dir.path(), &[(adrm_key("conta", "abcd"), NOW + 60_000)]);
    assert_eq!(
        guard_evidence(&path, "conta", "abcd", true, NOW),
        ReuploadEvidence::BlockedButInventoryReady
    );
}

#[test]
fn marca_vencida_e_clear() {
    // `expires_at <= now` já é expiração: a marca não protege mais nada.
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(
        dir.path(),
        &[
            (adrm_key("conta", "abcd"), NOW),
            (adrm_key("conta", "beef"), NOW - 1),
        ],
    );
    assert_eq!(
        guard_evidence(&path, "conta", "abcd", false, NOW),
        ReuploadEvidence::Clear
    );
    assert_eq!(
        guard_evidence(&path, "conta", "beef", true, NOW),
        ReuploadEvidence::Clear
    );
}

#[test]
fn conta_ou_hash_vazio_e_unavailable_mesmo_com_marca_viva() {
    // Conta/hash vazio é erro de leitura em `read_adrm_block`; converter para
    // `Clear` autorizaria upload sobre uma consulta que nunca aconteceu.
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(dir.path(), &[(adrm_key("conta", "abcd"), NOW + 60_000)]);
    assert_eq!(
        guard_evidence(&path, "", "abcd", false, NOW),
        ReuploadEvidence::Unavailable
    );
    assert_eq!(
        guard_evidence(&path, "   ", "abcd", true, NOW),
        ReuploadEvidence::Unavailable
    );
    assert_eq!(
        guard_evidence(&path, "conta", "", true, NOW),
        ReuploadEvidence::Unavailable
    );
}

#[test]
fn banco_inexistente_e_unavailable_e_nao_cria_arquivo() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ausente.db");
    assert_eq!(
        guard_evidence(&path, "conta", "abcd", false, NOW),
        ReuploadEvidence::Unavailable
    );
    assert_eq!(
        guard_evidence(&path, "conta", "abcd", true, NOW),
        ReuploadEvidence::Unavailable
    );
    // Abrir read-only: a própria tradução não pode criar o banco que faltou.
    assert!(!path.exists());
}

#[test]
fn evidencia_dirige_a_decisao_de_enqueue_sem_efeito() {
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(dir.path(), &[(adrm_key("conta", "abcd"), NOW + 60_000)]);
    let decisao = |conta: &str, inventario: bool| {
        enqueue_decision(guard_evidence(&path, conta, "abcd", inventario, NOW))
    };
    assert_eq!(decisao("conta", false), EnqueueDecision::Blocked);
    assert_eq!(decisao("conta", true), EnqueueDecision::AlreadyReady);
    assert_eq!(decisao("outra", false), EnqueueDecision::Upload);
    assert_eq!(decisao("", false), EnqueueDecision::GuardUnavailable);
    // A leitura não apaga a marca: a decisão de limpar é do worker.
    assert!(read_adrm_block(&path, "conta", "abcd", NOW).unwrap());
}
