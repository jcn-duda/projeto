//! Testes do gravador de efeitos do play sobre o SQLite de verdade (arquivo
//! temporário). Cada caso prova uma linha da régua do TS.

use super::*;
use adom_core::{account_scope, ledger_key, WorkTarget};
use adom_index::MagnetState;
use serde_json::json;

const HASH: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";
const IMDB: &str = "tt0944947";

fn cfg() -> EffectConfig {
    EffectConfig {
        magnet_db: true,
        alive_ttl: 7 * 24 * 3600,
        bad_ttl: 24 * 3600,
        lie_enabled: true,
        lie_ttl: 7 * 24 * 3600,
        avail_neg_ttl: 120,
        rd_ledger: true,
        rd_blocked_ttl: 2_592_000.0,
        blocked_cooldown_ms: 30_000,
    }
}

fn job(service: &str) -> PlayJob {
    PlayJob {
        service: service.into(),
        api_key: "chave-de-teste".into(),
        hash: HASH.into(),
        imdb: IMDB.into(),
        season: Some(2),
        episode: Some(5),
    }
}

fn efeito(mark: Value, invalidate: &str, index: Value, note_blocked: bool) -> Value {
    json!({
        "status": 404,
        "kind": "x",
        "body": "x",
        "mark": mark,
        "noteBlocked": note_blocked,
        "unprotect": false,
        "invalidate": invalidate,
        "index": index,
    })
}

fn arquivo(path: &str, size: f64) -> Vec<PlayFile> {
    vec![PlayFile {
        path: path.into(),
        size,
    }]
}

/// Gravador sobre um `cache.db` novo. O `TempDir` precisa ficar vivo no teste.
fn fresh() -> (tempfile::TempDir, NativePlayEffects, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("cache.db");
    let fx = NativePlayEffects::open_at(cfg(), &path, None);
    (dir, fx, path)
}

fn state(fx: &NativePlayEffects, service: &str) -> Option<MagnetState> {
    fx.mag
        .as_ref()
        .expect("mag aberto")
        .state(service, "chave-de-teste", HASH, now_ms())
        .expect("leitura")
}

#[test]
fn ok_com_arquivos_grava_tamanho_e_prova() {
    let (_dir, fx, _) = fresh();
    let now = now_ms();
    fx.apply_ok(
        job("alldebrid"),
        false,
        false,
        Some(arquivo("Serie.S02E05.1080p.WEB-DL.mkv", 1_500_000_000.0)),
    );
    let kv = fx.kv().expect("kv");
    let fsz = kv
        .get_json(&adom_debrid::file_sizes::files_key(HASH), now)
        .expect("leitura")
        .expect("fsz gravado");
    assert_eq!(fsz[0]["path"], "Serie.S02E05.1080p.WEB-DL.mkv");
    let prova = fx
        .index
        .as_ref()
        .expect("idx")
        .file_evidence(HASH, now)
        .expect("prova gravada");
    assert!(
        prova.q.contains("1080"),
        "resolução do maior vídeo: {}",
        prova.q
    );
}

#[test]
fn frio_do_play_grava_davail_negativo_e_so_com_ttl() {
    let (_dir, fx, _) = fresh();
    let now = now_ms();
    fx.apply_ok(job("torbox"), false, true, None);
    let davail = fx.davail.as_ref().expect("davail");
    assert_eq!(
        davail.get("torbox", "chave-de-teste", HASH, now).unwrap(),
        Some(false)
    );

    // TTL 0 desliga a janela: nada é gravado.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let off = NativePlayEffects::open_at(
        EffectConfig {
            avail_neg_ttl: 0,
            ..cfg()
        },
        &path,
        None,
    );
    off.apply_ok(job("torbox"), false, true, None);
    let davail = off.davail.as_ref().expect("davail");
    assert_eq!(
        davail.get("torbox", "chave-de-teste", HASH, now).unwrap(),
        None
    );
}

#[test]
fn vivo_marca_alive_e_o_bad_do_erro_derruba() {
    let (_dir, fx, _) = fresh();
    fx.apply_ok(job("alldebrid"), true, false, None);
    assert_eq!(state(&fx, "alldebrid"), Some(MagnetState::Alive));
    fx.apply_error(
        job("alldebrid"),
        efeito(json!("bad"), "obra", Value::Null, false),
        None,
    );
    assert_eq!(state(&fx, "alldebrid"), Some(MagnetState::Bad));
}

#[test]
fn magnet_db_desligado_nao_marca_vivo() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let fx = NativePlayEffects::open_at(
        EffectConfig {
            magnet_db: false,
            ..cfg()
        },
        &path,
        None,
    );
    fx.apply_ok(job("alldebrid"), true, false, None);
    assert_eq!(state(&fx, "alldebrid"), None);
}

#[test]
fn lie_com_unprotect_apaga_a_retencao_da_conta() {
    let (_dir, fx, _) = fresh();
    let now = now_ms();
    let account = account_scope(&Value::String("chave-de-teste".into()));
    let adprot = format!("adprot:v1:alldebrid:{account}:{HASH}");
    let kv = fx.kv().expect("kv");
    kv.put_json(&adprot, &json!({ "at": now }), 0, now).unwrap();

    let mut effect = efeito(json!("lie"), "obra", json!("lied"), false);
    effect["unprotect"] = json!(true);
    fx.apply_error(job("alldebrid"), effect, None);

    assert_eq!(state(&fx, "alldebrid"), Some(MagnetState::Lie));
    assert_eq!(kv.get_json(&adprot, now).unwrap(), None);
}

#[test]
fn bloqueio_no_rd_grava_ledger_e_nao_marca_bad() {
    let (_dir, fx, _) = fresh();
    let now = now_ms();
    fx.apply_error(
        job("realdebrid"),
        efeito(Value::Null, "streams", Value::Null, true),
        None,
    );
    let ledger = fx
        .kv()
        .expect("kv")
        .get_json(&ledger_key(HASH), now)
        .unwrap()
        .expect("ledger gravado");
    assert_eq!(ledger["s"], "blocked");
    assert_eq!(state(&fx, "realdebrid"), None, "451 nunca vira bad");
}

#[test]
fn bloqueio_fora_do_rd_nao_mexe_no_ledger() {
    let (_dir, fx, _) = fresh();
    fx.apply_error(
        job("torbox"),
        efeito(Value::Null, "streams", Value::Null, true),
        None,
    );
    assert_eq!(
        fx.kv()
            .unwrap()
            .get_json(&ledger_key(HASH), now_ms())
            .unwrap(),
        None
    );
}

#[test]
fn episodio_ausente_e_temporada_inteira_no_indice() {
    let (_dir, fx, _) = fresh();
    let now = now_ms();
    fx.apply_error(
        job("alldebrid"),
        efeito(Value::Null, "none", json!("missing"), false),
        None,
    );
    let index = fx.index.as_ref().expect("idx");
    let s2e5 = WorkTarget {
        season: Some(2),
        episode: Some(5),
    };
    assert!(index.is_missing(IMDB, s2e5, HASH, now));

    // Temporada 3 inteira: a marca de temporada vale sem episódio no alvo.
    let mut tres = job("alldebrid");
    tres.season = Some(3);
    tres.episode = None;
    fx.apply_error(
        tres,
        efeito(Value::Null, "none", json!("missing-season"), false),
        None,
    );
    let so_temporada = WorkTarget {
        season: Some(3),
        episode: None,
    };
    assert!(index.is_missing(IMDB, so_temporada, HASH, now));
}

#[test]
fn obra_sem_imdb_valido_nao_toca_o_indice() {
    let (_dir, fx, _) = fresh();
    let now = now_ms();
    let mut sem = job("alldebrid");
    sem.imdb = String::new();
    fx.apply_error(
        sem,
        efeito(Value::Null, "obra", json!("missing"), false),
        None,
    );
    let s2e5 = WorkTarget {
        season: Some(2),
        episode: Some(5),
    };
    assert!(!fx.index.as_ref().unwrap().is_missing(IMDB, s2e5, HASH, now));
}

#[test]
fn plano_do_bloqueio_zera_mark_e_unprotect() {
    let plan = plan::EffectPlan::from_value(&json!({
        "mark": "bad",
        "unprotect": true,
        "noteBlocked": true,
        "invalidate": "streams",
        "index": "missing",
    }));
    assert_eq!(plan.mark, None);
    assert!(!plan.unprotect);
    assert!(plan.note_blocked);
    assert_eq!(plan.invalidate, plan::Invalidate::Streams);
    assert_eq!(plan.index, Some(plan::IndexMark::Missing));
}

#[test]
fn valor_fora_do_vocabulario_vira_nada() {
    let plan =
        plan::EffectPlan::from_value(&json!({ "mark": "x", "invalidate": "tudo", "index": "y" }));
    assert_eq!(plan.mark, None);
    assert_eq!(plan.invalidate, plan::Invalidate::None);
    assert_eq!(plan.index, None);
}

#[test]
fn cooldown_do_bloqueio() {
    // Instantes em ms de relógio real: a primeira limpeza (last = 0) sempre passa;
    // depois só quando o cooldown inteiro já correu.
    let t = 1_700_000_000_000;
    assert!(writes::blocked_clear_due(0, t, 30_000));
    assert!(!writes::blocked_clear_due(t, t + 20_000, 30_000));
    assert!(writes::blocked_clear_due(t, t + 30_000, 30_000));
}

#[test]
fn imdb_so_com_tt_e_digitos() {
    assert!(writes::is_imdb("tt0944947"));
    assert!(!writes::is_imdb("tt"));
    assert!(!writes::is_imdb("0944947"));
    assert!(!writes::is_imdb("tt12x"));
}
