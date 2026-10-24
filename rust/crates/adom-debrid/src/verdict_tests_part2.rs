use super::*;
use crate::alldebrid_cleanup::{account_scope, adrm_key, CleanupMode, DurablePeek};
use crate::holds_feed::HoldsFacts;
use crate::verdict::alldebrid_opts;

// ── Fatos do feed de holds → CheckOpts (AllDebrid) ──────────────────────────

const ACCOUNT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BATCH: [&str; 2] = [HIT, MISS];

fn holds_facts(complete: bool, evaluated: &[&str]) -> HoldsFacts {
    HoldsFacts {
        account: ACCOUNT.into(),
        inventory_loaded: true,
        known_before: vec![DARK.into()],
        held: vec![MISS.into()],
        evaluated: evaluated.iter().map(|h| (*h).to_string()).collect(),
        holds_complete: complete,
        drop_ready: Some(false),
        drop_uncached: Some(true),
    }
}

fn batch() -> Vec<String> {
    BATCH.iter().map(|h| (*h).to_string()).collect()
}

/// Leitor de um `cache.db` que não existe: sem `adrm`, sem `adprot`/`adsub`.
/// Caminho relativo ao crate (cwd do `cargo test`) e nunca criado.
fn no_peek() -> DurablePeek {
    DurablePeek::new("cache.db.inexistente")
}

/// `cache.db` mínimo do Node (`src/utils/cache-db-open.ts`) com `expires_at`
/// explícito por chave.
fn cache_db(dir: &std::path::Path, rows: &[(&str, i64)]) -> std::path::PathBuf {
    let path = dir.join("cache.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
    )
    .unwrap();
    for (key, expires_at) in rows {
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
            rusqlite::params![key, expires_at],
        )
        .unwrap();
    }
    path
}

/// Limpeza OFF (default): read-only de verdade — fatos e drops ignorados, nem
/// inventário nem guarda durável são montados. O filtro de upload (`adrm`) é a
/// exceção: leitura read-only que vale SEMPRE.
#[test]
fn alldebrid_opts_limpeza_off_ignora_fatos() {
    let facts = holds_facts(true, &BATCH);
    let peek = no_peek();
    let opts = alldebrid_opts(CleanupMode::Off, None, Some(&facts), &batch(), KEY, &peek);
    assert!(!opts.cleanup.is_on());
    assert!(!opts.drop_ready);
    assert!(!opts.drop_uncached);
    assert!(!opts.inventory_loaded);
    assert!(!opts.holds_complete);
    assert!(opts.known_before.is_empty());
    assert!(opts.held.is_empty());
    assert!(
        opts.durable.is_none(),
        "flag OFF não entrega a guarda `adprot`/`adsub` à limpeza"
    );
    assert!(opts.blocked.is_empty(), "sem cache.db não há bloqueio");
}

/// Limpeza ON sem feed: comportamento anterior preservado (read-only por
/// `holds_incomplete`), com os drops do ambiente.
#[test]
fn alldebrid_opts_sem_fatos_continua_read_only() {
    let _env = EnvGuard::set(&[
        ("DEBRID_DROP_READY", None),
        ("DEBRID_DROP_UNCACHED", Some("false")),
    ]);
    let peek = no_peek();
    let opts = alldebrid_opts(CleanupMode::On, None, None, &batch(), KEY, &peek);
    assert!(opts.drop_ready, "default do ambiente é true");
    assert!(!opts.drop_uncached, "env manda quando não há fato");
    assert!(!opts.inventory_loaded);
    assert!(!opts.holds_complete, "sem prova o plano nasce suprimido");
    assert!(opts.durable.is_some());
}

/// Fatos completos: drops/inventário/hold do Node viajam e `holds_complete`
/// só fica verdadeiro porque `evaluated` cobre o lote.
#[test]
fn alldebrid_opts_fatos_completos_autorizam_o_plano() {
    let facts = holds_facts(true, &BATCH);
    let peek = no_peek();
    let opts = alldebrid_opts(
        CleanupMode::On,
        Some(Duration::from_millis(123)),
        Some(&facts),
        &batch(),
        KEY,
        &peek,
    );
    assert_eq!(opts.timeout, Some(Duration::from_millis(123)));
    assert!(!opts.drop_ready);
    assert!(opts.drop_uncached);
    assert!(opts.inventory_loaded);
    assert!(opts.holds_complete);
    assert!(opts.known_before.contains(DARK));
    assert!(opts.held.contains(MISS));
    assert!(opts.durable.is_some());
}

/// `holdsComplete:true` com `evaluated` parcial NÃO autoriza: a cobertura é
/// reconferida no Rust (fail-closed).
#[test]
fn alldebrid_opts_fatos_incompletos_nao_autorizam() {
    let partial = holds_facts(true, &[HIT]);
    let peek = no_peek();
    let opts = alldebrid_opts(CleanupMode::On, None, Some(&partial), &batch(), KEY, &peek);
    assert!(!opts.holds_complete, "evaluated não cobre o lote");
    // O que foi provado (held/inventário) continua indo: protege mais, nunca
    // menos.
    assert!(opts.held.contains(MISS));
    assert!(opts.inventory_loaded);

    let lying = holds_facts(false, &BATCH);
    let opts = alldebrid_opts(CleanupMode::On, None, Some(&lying), &batch(), KEY, &peek);
    assert!(!opts.holds_complete, "flag falso do Node nunca vira prova");
}

/// O `blocked` vem do `adrm:v1` do `cache.db` do Node e vale MESMO com a
/// limpeza OFF — é filtro de upload, não guarda da limpeza. O expirado não
/// bloqueia (o TTL de 3 dias é quem manda) e o `durable` da limpeza continua
/// `None` até a flag ligar.
#[test]
fn alldebrid_opts_blocked_vem_do_adrm_com_limpeza_off() {
    let account = account_scope(KEY);
    let now = crate::error::now_ms() as i64;
    let vivo = adrm_key(&account, HIT);
    let expirado = adrm_key(&account, MISS);
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(
        dir.path(),
        &[(&vivo, now + 60_000), (&expirado, now - 1_000)],
    );
    let peek = DurablePeek::new(path);
    let opts = alldebrid_opts(CleanupMode::Off, None, None, &batch(), KEY, &peek);
    assert!(opts.blocked.contains(HIT), "adrm vivo sai do upload");
    assert!(!opts.blocked.contains(MISS), "adrm expirado não bloqueia");
    assert!(opts.durable.is_none(), "a guarda da limpeza segue OFF");

    let opts = alldebrid_opts(CleanupMode::On, None, None, &batch(), KEY, &peek);
    assert!(
        opts.blocked.contains(HIT),
        "o mesmo bloqueio vale com a limpeza ON"
    );
    assert!(opts.durable.is_some(), "ON entrega a guarda à limpeza");
}

/// Prova de ponta: o hash com `adrm` vivo NÃO chega ao `/magnet/upload` (que é
/// a própria consulta de cache) — o mock conta o que trafegou.
#[tokio::test]
async fn adrm_tira_o_hash_do_upload_mesmo_com_limpeza_off() {
    let body = json!({
        "status": "success",
        "data": { "magnets": [{ "hash": MISS, "ready": true, "id": 12 }] }
    })
    .to_string();
    let (up, app) = upstream(200, &body);
    let base = serve(app).await;
    let account = account_scope(KEY);
    let now = crate::error::now_ms() as i64;
    let vivo = adrm_key(&account, HIT);
    let expirado = adrm_key(&account, DARK);
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(
        dir.path(),
        &[(&vivo, now + 60_000), (&expirado, now - 1_000)],
    );
    let cache_str = path.to_string_lossy().to_string();
    let _env = EnvGuard::set(&[
        ("ALLDEBRID_API_BASE", Some(&base)),
        ("CACHE_DB_PATH", Some(cache_str.as_str())),
        ("DEBRID_AL_CLEANUP", None),
    ]);
    let outcome = check_service(
        "alldebrid",
        KEY,
        &[HIT.into(), DARK.into(), MISS.into()],
        Some(Duration::from_millis(2_000)),
        None,
    )
    .await
    .unwrap();
    assert!(
        is_cached(&outcome, MISS),
        "o hash livre foi perguntado e é ⚡"
    );
    assert!(
        !is_cached(&outcome, HIT),
        "bloqueado não é ⚡: ele nem foi ao upload"
    );
    let queries: Vec<String> = up
        .hits
        .lock()
        .unwrap()
        .iter()
        .map(|(_, query)| query.clone())
        .collect();
    assert!(
        queries.iter().all(|query| !query.contains(HIT)),
        "o hash com `adrm` vivo não pode ir ao /magnet/upload: {queries:?}"
    );
    assert!(
        queries.iter().any(|query| query.contains(DARK)),
        "`adrm` expirado não bloqueia (o hash volta ao upload): {queries:?}"
    );
    assert!(queries.iter().any(|query| query.contains(MISS)));
}

/// A checagem com fatos atravessa `check_service_report_with` sem mexer no
/// veredito: o plano é só um efeito do corpo, nunca da resposta.
#[tokio::test]
async fn check_com_fatos_mantem_o_veredito() {
    let body = json!({
        "status": "success",
        "data": {
            "magnets": [
                { "hash": HIT, "ready": true, "id": 11 },
                { "hash": MISS, "ready": false, "id": 12 }
            ]
        }
    })
    .to_string();
    let base = serve(upstream(200, &body).1).await;
    // Cache durável inexistente: o teste não pode depender do cache.db do host.
    let cache_db =
        std::env::temp_dir().join(format!("adom-holds-verdict-{}.db", std::process::id()));
    let _env = EnvGuard::set(&[
        ("ALLDEBRID_API_BASE", Some(&base)),
        (
            "CACHE_DB_PATH",
            Some(cache_db.to_str().unwrap_or("nao-existe.db")),
        ),
        ("DEBRID_AL_CLEANUP", Some("on")),
    ]);
    let facts = holds_facts(true, &BATCH);
    let report = super::super::check_service_report_with(
        "alldebrid",
        KEY,
        &[HIT.into(), MISS.into()],
        Some(Duration::from_millis(2000)),
        None,
        Some(&facts),
    )
    .await
    .unwrap();
    assert!(report.outcome.known);
    assert!(is_cached(&report.outcome, HIT));
    assert!(!is_cached(&report.outcome, MISS));
}
