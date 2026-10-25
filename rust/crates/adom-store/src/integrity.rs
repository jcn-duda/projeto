//! Integridade do SQLite: `PRAGMA quick_check` + quarentena do arquivo podre.
//!
//! Um `streams.db` truncado (queda de energia, disco cheio, cópia interrompida)
//! não impede o `Connection::open` — o SQLite só lê páginas na primeira
//! consulta, então o erro aparece depois, no `CREATE TABLE` do schema, com
//! "database disk image is malformed". No boot isso derrubava o serviço: o
//! `open` devolvia `Err` e quem chamava não tinha de onde subir.
//!
//! Aqui o arquivo é TESTADO antes de ser usado. Se o `quick_check` não disser
//! `ok`, ele é renomeado para `<arquivo>.corrupt-<epoch>` (nada é apagado — o
//! arquivo é a evidência do incidente) e o schema é recriado do zero. O store
//! abre **degradado**: perde o cache antigo, mas o serviço responde e o
//! operador vê `degraded`/`storeError` no painel.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

/// Como o arquivo abriu. `degraded` = o conteúdo antigo foi para a quarentena.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenReport {
    pub degraded: bool,
    pub error: Option<String>,
}

impl OpenReport {
    /// Arquivo íntegro (ou recém-criado).
    pub fn healthy() -> Self {
        Self::default()
    }

    /// O `quick_check` reprovou: `error` é o que ele respondeu + o destino.
    pub fn quarantined(error: String) -> Self {
        Self {
            degraded: true,
            error: Some(error),
        }
    }
}

/// Abre `path` com `quick_check`; arquivo podre vira quarentena + schema novo.
///
/// `schema` é o batch idempotente do store (`CREATE TABLE IF NOT EXISTS …`):
/// roda DEPOIS da checagem, tanto no arquivo saudável quanto no recriado.
pub fn open_quarantined(path: &Path, schema: &str) -> Result<(Connection, OpenReport), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("pasta do banco {}: {err}", path.display()))?;
        }
    }
    let mut conn = open_conn(path)?;
    let mut report = OpenReport::healthy();
    if let Err(err) = quick_check(&conn) {
        // A conexão precisa cair ANTES do rename: no Windows o arquivo aberto
        // não pode ser movido.
        drop(conn);
        let quarantined = quarantine(path)?;
        report = OpenReport::quarantined(format!(
            "{err}; arquivo movido para {}",
            quarantined.display()
        ));
        conn = open_conn(path)?;
    }
    conn.execute_batch(schema)
        .map_err(|err| format!("schema de {}: {err}", path.display()))?;
    Ok((conn, report))
}

/// Abre `path` READ-ONLY e confere a integridade sem tocar no arquivo.
///
/// Para o banco cujo dono da escrita é outro processo (`cache.db` do Node):
/// renomear/quarentenar aqui deixaria o dono escrevendo num inode órfão, então
/// o caller recebe a conexão com o veredito em [`OpenReport`] e decide.
pub fn open_read_only_checked(path: &Path) -> Result<(Connection, OpenReport), String> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("abrir {} (read-only): {err}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_millis(5_000))
        .map_err(|err| err.to_string())?;
    let report = match quick_check(&conn) {
        Ok(()) => OpenReport::healthy(),
        Err(err) => {
            OpenReport::quarantined(format!("{err} (arquivo de outro dono: não foi movido)"))
        }
    };
    Ok((conn, report))
}

/// `PRAGMA quick_check` só passa quando a única linha devolvida é `ok`.
///
/// `quick_check` (≠ `integrity_check`) não confere índice contra tabela, mas
/// varre as páginas: é o que pega o arquivo truncado sem pagar a checagem
/// completa no boot.
pub fn quick_check(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA quick_check")
        .map_err(|err| format!("quick_check: {err}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("quick_check: {err}"))?;
    let mut problems = Vec::new();
    for row in rows {
        problems.push(row.map_err(|err| format!("quick_check: {err}"))?);
    }
    if problems.len() == 1 && problems[0] == "ok" {
        return Ok(());
    }
    if problems.is_empty() {
        return Err("quick_check: nenhum resultado".to_string());
    }
    Err(format!("quick_check: {}", problems.join("; ")))
}

/// Move `<arquivo>` (e os irmãos `-wal`/`-shm`) para `<arquivo>.corrupt-<epoch>`.
///
/// Os sidecars vão junto: um `-wal` órfão ao lado do banco NOVO é lixo que o
/// SQLite tentaria recuperar. Devolve o destino do arquivo principal.
fn quarantine(path: &Path) -> Result<PathBuf, String> {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let name = path
        .file_name()
        .ok_or_else(|| format!("caminho sem nome de arquivo: {}", path.display()))?
        .to_string_lossy()
        .to_string();
    let target = path.with_file_name(format!("{name}.corrupt-{epoch}"));
    std::fs::rename(path, &target)
        .map_err(|err| format!("quarentena de {}: {err}", path.display()))?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        if sidecar.exists() {
            let mut target_sidecar = target.as_os_str().to_os_string();
            target_sidecar.push(suffix);
            let _ = std::fs::rename(&sidecar, PathBuf::from(target_sidecar));
        }
    }
    Ok(target)
}

fn open_conn(path: &Path) -> Result<Connection, String> {
    Connection::open(path).map_err(|err| format!("abrir {}: {err}", path.display()))
}

#[cfg(test)]
#[path = "integrity_tests.rs"]
mod integrity_tests;
