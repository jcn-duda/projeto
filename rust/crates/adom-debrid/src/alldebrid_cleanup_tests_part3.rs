use super::*;

// ── Fila de delete: backoff, rodadas, quota/auth, kill-switch e gate ────────

#[tokio::test]
async fn backoff_retenta_na_mesma_rodada_e_na_segunda() {
    // Falha 2× (as duas tentativas da 1ª rodada) e sucede na 2ª rodada.
    let scene = scene("", &[], DeleteMode::FailTimes(2));
    let ad = open_scene(scene.clone()).await;
    let config = DeleteConfig {
        delays: vec![Duration::ZERO, Duration::ZERO],
        concurrency: 1,
        rounds: 2,
        kill: Some(false),
    };
    let report = delete_with_backoff(&ad, KEY, &["101".to_string()], config).await;
    assert_eq!(report.removed, vec!["101".to_string()]);
    assert!(report.failed.is_empty());
    assert_eq!(report.attempts, 3);
    let seen = hits(&scene);
    assert_eq!(seen.len(), 3);
    assert!(seen.iter().all(|hit| hit.auth_ok), "chave só no header");
    assert!(seen
        .iter()
        .all(|hit| values(&hit.query, "id") == vec!["101".to_string()]));
}

#[tokio::test]
async fn falha_persistente_vira_failed() {
    let scene = scene("", &[], DeleteMode::Always500);
    let ad = open_scene(scene.clone()).await;
    let config = DeleteConfig {
        delays: vec![Duration::ZERO, Duration::ZERO],
        concurrency: 4,
        rounds: 2,
        kill: Some(false),
    };
    let report = delete_with_backoff(&ad, KEY, &["101".to_string()], config).await;
    assert!(report.removed.is_empty());
    assert_eq!(report.failed, vec!["101".to_string()]);
    assert_eq!(report.attempts, 4);
    assert_eq!(report.stopped, None, "503/rede não é terminal");
}

#[tokio::test]
async fn quota_derruba_a_fila_e_nao_vira_unusable() {
    let scene = scene("", &[], DeleteMode::Quota);
    let ad = open_scene(scene.clone()).await;
    let config = DeleteConfig {
        delays: vec![Duration::ZERO, Duration::ZERO],
        concurrency: 1,
        rounds: 2,
        kill: Some(false),
    };
    let report = delete_with_backoff(
        &ad,
        KEY,
        &["101".to_string(), "102".to_string(), "103".to_string()],
        config,
    )
    .await;
    assert_eq!(report.stopped, Some(DeleteStop::Quota));
    assert!(report.removed.is_empty());
    assert_eq!(report.failed.len(), 3, "nenhum id some do relatório");
    assert_eq!(report.attempts, 1, "insistir em quota não gasta o teto");
    assert_eq!(delete_hits(&scene), 1);
}

#[tokio::test]
async fn rate_limit_usa_retry_after_e_continua() {
    let scene = scene("", &[], DeleteMode::RateThenOk);
    let ad = open_scene(scene.clone()).await;
    // O backoff configurado é longo; o `Retry-After: 0` vence e a fila não para.
    let config = DeleteConfig {
        delays: vec![Duration::from_secs(5), Duration::from_secs(5)],
        concurrency: 1,
        rounds: 1,
        kill: Some(false),
    };
    let report = delete_with_backoff(&ad, KEY, &["101".to_string()], config).await;
    assert_eq!(report.removed, vec!["101".to_string()]);
    assert_eq!(report.stopped, None, "rate limit é transitório");
    assert_eq!(report.attempts, 2);
}

#[tokio::test]
async fn kill_switch_para_a_fila() {
    let scene = scene("", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let config = DeleteConfig {
        kill: Some(true),
        ..DeleteConfig::fast()
    };
    let report = delete_with_backoff(&ad, KEY, &["101".to_string()], config).await;
    assert_eq!(report.stopped, Some(DeleteStop::KillSwitch));
    assert!(report.removed.is_empty());
    assert_eq!(delete_hits(&scene), 0);
}

#[tokio::test]
async fn uma_execucao_de_delete_por_conta() {
    let mut scene = Arc::try_unwrap(scene("", &[], DeleteMode::Ok))
        .ok()
        .unwrap();
    scene.slow_delete = Duration::from_millis(40);
    let scene = Arc::new(scene);
    let ad = open_scene(scene.clone()).await;
    let config = DeleteConfig {
        delays: Vec::new(),
        concurrency: 1,
        rounds: 1,
        kill: Some(false),
    };
    let ids_one = ["101".to_string()];
    let ids_two = ["102".to_string()];
    let one = delete_with_backoff(&ad, KEY, &ids_one, config.clone());
    let two = delete_with_backoff(&ad, KEY, &ids_two, config);
    let (first, second) = tokio::join!(one, two);
    assert_eq!(first.removed.len(), 1);
    assert_eq!(second.removed.len(), 1);
    assert_eq!(
        scene.max_inflight.load(Ordering::SeqCst),
        1,
        "o gate da conta serializa as execuções"
    );
    assert_eq!(delete_hits(&scene), 2);
}

#[tokio::test]
async fn delete_sem_ids_nao_pede_rede() {
    let scene = scene("", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let report = delete_with_backoff(
        &ad,
        KEY,
        &[],
        DeleteConfig {
            kill: Some(false),
            ..DeleteConfig::fast()
        },
    )
    .await;
    assert_eq!(report, crate::alldebrid_delete::DeleteReport::default());
    assert!(hits(&scene).is_empty());
}

#[test]
fn chave_da_protecao_bate_com_o_node() {
    let account = account_scope("minha-chave");
    assert_eq!(account.len(), 64);
    assert!(account.chars().all(|ch| ch.is_ascii_hexdigit()));
    assert_eq!(
        adprot_key(&account, "ABCD"),
        format!("adprot:v1:alldebrid:{account}:abcd")
    );
    assert_eq!(
        adsub_key(&account, "ABCD"),
        format!("adsub:v1:{account}:abcd")
    );
    // `adrm` NÃO leva segmento de adaptador (`alldebrid-reupload.ts::key`).
    assert_eq!(
        adrm_key(&account, "ABCD"),
        format!("adrm:v1:{account}:abcd")
    );
}

/// Anti-reenchimento (`adrm:v1`): a checagem só enxerga o bloqueio VIVO da
/// própria conta. Expirado, de outra conta ou de outro namespace não entra —
/// a fonte é read-only, então nada aqui pode gravar/apagar.
#[test]
fn blocked_hashes_so_devolve_adrm_vivo_da_propria_conta() {
    let account = account_scope("ad-adrm-conta");
    let outra = account_scope("ad-adrm-outra");
    let now = crate::error::now_ms() as i64;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
        )
        .unwrap();
        let rows = [
            (adrm_key(&account, &hash_of('a')), now + 60_000),
            (adrm_key(&account, &hash_of('b')), now - 1_000),
            (adrm_key(&outra, &hash_of('c')), now + 60_000),
            (adsub_key(&account, &hash_of('d')), now + 60_000),
        ];
        for (key, expires_at) in rows {
            conn.execute(
                "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
                rusqlite::params![key, expires_at],
            )
            .unwrap();
        }
    }
    let peek = DurablePeek::new(path);
    assert_eq!(
        peek.blocked_hashes(&account, now),
        HashSet::from([hash_of('a')]),
        "só o adrm vivo desta conta bloqueia o upload"
    );
}

/// Kill-switch/TTL do anti-reenchimento: as MESMAS envs do Node
/// (`DEBRID_REUPLOAD_BLOCK`/`ALLDEBRID_REUPLOAD_BLOCK_TTL_MS`). Desligado ou TTL
/// 0 devolve conjunto vazio SEM abrir o banco — rollback de uma linha no Node
/// também desliga o filtro nativo.
#[test]
fn blocked_hashes_respeita_kill_switch_e_ttl_do_node() {
    use super::super::{reupload_block_enabled_from, reupload_flag_from, reupload_ttl_ms_from};

    // `enabled()` do `alldebrid-reupload.ts`, caso a caso.
    assert!(
        reupload_block_enabled_from(None, None),
        "default: ligado, 3d"
    );
    assert!(!reupload_block_enabled_from(Some("false"), None));
    assert!(
        reupload_block_enabled_from(Some(""), None),
        "vazio = default true"
    );
    assert!(!reupload_block_enabled_from(Some("true"), Some("0")));
    assert!(!reupload_block_enabled_from(Some("true"), Some("")));
    assert!(!reupload_block_enabled_from(Some("true"), Some("-1")));
    assert!(reupload_block_enabled_from(Some("true"), Some("86400000")));
    // Valor não numérico cai no default do Node (`num`), nunca em 0.
    assert_eq!(reupload_ttl_ms_from(Some("abc")), 259_200_000.0);
    assert_eq!(reupload_ttl_ms_from(None), 259_200_000.0);
    assert!(reupload_flag_from(None));
    assert!(!reupload_flag_from(Some("yes")), "Node compara '=== true'");

    let account = account_scope("ad-adrm-switch");
    let now = crate::error::now_ms() as i64;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
            rusqlite::params![adrm_key(&account, &hash_of('a')), now + 60_000],
        )
        .unwrap();
    }
    let peek = DurablePeek::new(path);
    assert_eq!(
        peek.blocked_hashes_when(&account, now, false),
        HashSet::new(),
        "kill-switch/TTL 0 desliga a leitura do adrm"
    );
    assert_eq!(
        peek.blocked_hashes_when(&account, now, true),
        HashSet::from([hash_of('a')]),
        "ligado, o adrm vivo volta a filtrar"
    );
}

/// `cache.db` ausente continua fail-open, mas NÃO silencioso: sai UM aviso por
/// processo (não um por checagem, que viraria spam) dizendo que o `adrm` virou
/// no-op. A trava é injetada para o teste não depender do estado do processo.
#[test]
fn cache_db_ausente_avisa_uma_vez_e_segue_fail_open() {
    use std::cell::{Cell, RefCell};
    use std::sync::OnceLock;

    let latch = OnceLock::new();
    let calls = Cell::new(0);
    let seen = RefCell::new(String::new());
    let emit = |msg: &str| {
        calls.set(calls.get() + 1);
        seen.borrow_mut().push_str(msg);
    };
    let path = Path::new("nao-existe/cache.db");
    for _ in 0..3 {
        super::super::warn_missing_cache_db_once(path, &latch, emit);
    }
    assert_eq!(calls.get(), 1, "o aviso sai uma vez por processo");
    let text = seen.borrow().clone();
    assert!(text.contains("cache.db ausente"), "{text}");
    assert!(text.contains("adrm"), "{text}");
    assert!(text.contains("NO-OP"), "{text}");
    assert!(latch.get().is_some(), "a trava fica marcada");

    // Fail-open intacto: sem banco, nada é bloqueado.
    let peek = DurablePeek::new(path);
    let now = crate::error::now_ms() as i64;
    assert!(peek
        .blocked_hashes(&account_scope("ad-sem-banco"), now)
        .is_empty());
}

/// Devolução das marcas da limpeza nativa ao Node (`/internal/debrid/marked`).
/// Filho deste módulo: reaproveita as fixtures do servidor falso da AllDebrid.
#[path = "alldebrid_marks_tests.rs"]
mod marked;
