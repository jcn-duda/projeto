//! Parada DERIVADA por progresso no laço do recheck (Fase 3 do Chupim): o
//! `TerminalProgress` de `recheck_poll` deixa de ser inalcançável.
//!
//! O oráculo é `src/providers/autofetch-progress.ts:57` (a régua, provada pura
//! em `adom-autofetch::v3::recheck::progress_tests`) e
//! `src/providers/autofetch-terminal.ts:90-131` (os efeitos do colapso). Aqui se
//! prova o FIO: lote no KV → `recheck::step` → colapso com os efeitos do modo
//! `progress` (blacklist, índice, retenção solta e represa, nunca remoção).
//!
//! Arquivo próprio: `recheck_tests.rs` e `recheck_removal_tests.rs` já estão no
//! teto de 400 linhas.

use std::sync::{Arc, Mutex};

use adom_autofetch::v3::{QueueV3, SuppressedV3, TorrentEvidence, TorrentProgress};
use adom_index::NativeKv;
use adom_sources::now_ms;

use super::super::fakes::FakeDebrid;
use super::super::index_record::{clear, register, test_lock, Op, Refuse};
use super::super::season_fill::SeasonHint;
use super::super::Policy;
use super::{read, step, write, Lot};

const SEARCH: &str = "tt8888888:1:1";
const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta-de-teste";
const TRANSFER: &str = "id-transfer";

fn hash_of(n: u32) -> String {
    format!("{n:040x}")
}

fn kv() -> NativeKv {
    NativeKv::open_memory().unwrap()
}

/// Réguas do teste: `recheck_max` alto de propósito — com o `3` do fixture o
/// lote entraria em settle (`LotOutcome::EnterSettle`) antes de a janela de
/// progresso fechar e a passagem de status nem rodaria. A régua sob teste é a
/// de PROGRESSO (`stall_streak` = 3, o default do `from_env`).
fn policy() -> Policy {
    Policy {
        recheck_max: 20,
        ..Policy::fixture()
    }
}

/// `bytes` de 1 GiB neste teste; `total` fica acima para nunca virar "completo".
fn sample(bytes: f64, speed: f64) -> TorrentProgress {
    TorrentProgress {
        bytes: Some(bytes),
        total: Some(4_000.0),
        speed: Some(speed),
        seeders: Some(0.0),
    }
}

/// Status do AllDebrid: `downloading` com progresso MEDIDO e o id da transferência.
fn evidence(bytes: f64, speed: f64) -> TorrentEvidence {
    TorrentEvidence {
        state: "downloading".to_string(),
        stalled: false,
        transfer_id: Some(TRANSFER.to_string()),
        via_id: false,
        progress: Some(sample(bytes, speed)),
    }
}

/// Serviço com o status escolhido para o hash (a memória de progresso vive no lote).
fn debrid_with(hash: &str, item: TorrentEvidence) -> FakeDebrid {
    let mut fake = FakeDebrid::accepting();
    fake.states.insert(hash.to_string(), item);
    fake
}

fn lot(hash: &str, now: i64) -> Lot {
    Lot {
        search_key: SEARCH.to_string(),
        adapter_id: ADAPTER.to_string(),
        account: ACCOUNT.to_string(),
        info_hashes: vec![hash.to_string()],
        created_at: now,
        ..Lot::default()
    }
}

/// (a) Progresso AVANÇANDO nunca é terminal: por mais passagens que rode, o hash
/// fica no lote, sem `dead:` e sem represa.
#[tokio::test]
async fn progresso_avancando_nunca_colapsa() {
    let kv = kv();
    let now = now_ms();
    let policy = policy();
    let hash = hash_of(1);
    write(&kv, &lot(&hash, now), policy, now).unwrap();

    for pass in 1..=6u32 {
        let bytes = 100.0 * f64::from(pass);
        let debrid = debrid_with(&hash, evidence(bytes, 1_000.0));
        let report = step(&kv, policy, &debrid, true, SEARCH, now).await.unwrap();
        assert!(!report.terminal, "passagem {pass} com bytes crescendo");
        assert_eq!(report.suppressed, 0);
        assert!(!QueueV3::new(&kv)
            .is_dead(ADAPTER, ACCOUNT, &hash, now)
            .unwrap());
        let saved = read(&kv, SEARCH, now).unwrap().unwrap();
        assert_eq!(saved.info_hashes, vec![hash.clone()]);
        let memory = saved.progress.get(&hash).expect("memória gravada no lote");
        assert_eq!(memory.streak, 0, "movimento zera o contador");
        assert_eq!(memory.last_bytes, bytes);
        assert_eq!(memory.last_id, TRANSFER);
    }
}

/// (b) `autoFetchStallStreak` passagens SEM progresso => colapso com o motivo
/// DERIVADO (`autofetch-progress.ts:109-111`), e não com o de morte comprovada.
#[tokio::test]
async fn n_passagens_paradas_colapsa_como_parada_derivada() {
    let kv = kv();
    let now = now_ms();
    let policy = policy();
    let hash = hash_of(2);
    write(&kv, &lot(&hash, now), policy, now).unwrap();

    // A 1ª passagem abre a janela; o limiar conta as seguintes.
    let mut passes = 0;
    loop {
        passes += 1;
        let debrid = debrid_with(&hash, evidence(1_000.0, 0.0));
        let report = step(&kv, policy, &debrid, true, SEARCH, now).await.unwrap();
        if report.terminal {
            assert_eq!(report.dead, 0, "não é morte comprovada");
            assert_eq!(report.resolved, 1, "parada derivada resolve o hash");
            break;
        }
        assert!(
            passes <= policy.stall_streak,
            "passaria do limiar sem colapsar"
        );
    }
    assert_eq!(
        passes,
        policy.stall_streak + 1,
        "baseline + `stall_streak` passagens paradas"
    );
    // Hash saiu do lote e virou `dead:` da conta.
    assert!(read(&kv, SEARCH, now).unwrap().is_none());
    assert!(QueueV3::new(&kv)
        .is_dead(ADAPTER, ACCOUNT, &hash, now)
        .unwrap());
    // Modo `progress` NUNCA remove direto: registro na represa com o id.
    let noted = SuppressedV3::new(&kv)
        .read(ADAPTER, ACCOUNT, &hash, now)
        .unwrap()
        .expect("hash represado");
    assert_eq!(noted.id, TRANSFER);
}

/// (c) Um único byte de progresso REINICIA o contador dentro do lote: o hash
/// quase condenado volta ao zero e sobrevive (`autofetch-progress.ts:92-108`).
#[tokio::test]
async fn progresso_reinicia_o_contador_no_lote() {
    let kv = kv();
    let now = now_ms();
    let policy = policy();
    let hash = hash_of(3);
    write(&kv, &lot(&hash, now), policy, now).unwrap();

    // Baseline + `stall_streak - 1` passagens paradas.
    for _ in 0..policy.stall_streak {
        let debrid = debrid_with(&hash, evidence(1_000.0, 0.0));
        let report = step(&kv, policy, &debrid, true, SEARCH, now).await.unwrap();
        assert!(!report.terminal);
    }
    let saved = read(&kv, SEARCH, now).unwrap().unwrap();
    assert_eq!(saved.progress.get(&hash).map(|m| m.streak), Some(2));

    // Movimento: janela nova.
    let debrid = debrid_with(&hash, evidence(1_001.0, 0.0));
    let report = step(&kv, policy, &debrid, true, SEARCH, now).await.unwrap();
    assert!(!report.terminal, "1 byte a mais é movimento");
    let saved = read(&kv, SEARCH, now).unwrap().unwrap();
    let memory = saved.progress.get(&hash).unwrap();
    assert_eq!(memory.streak, 0);
    assert_eq!(memory.last_bytes, 1_001.0);

    // E o limiar é contado de novo: mais uma parada ainda não condena.
    let debrid = debrid_with(&hash, evidence(1_001.0, 0.0));
    let report = step(&kv, policy, &debrid, true, SEARCH, now).await.unwrap();
    assert!(!report.terminal, "streak residual não condena");
    let saved = read(&kv, SEARCH, now).unwrap().unwrap();
    assert_eq!(saved.progress.get(&hash).map(|m| m.streak), Some(1));
}

/// (d) Os efeitos do modo `progress` são disparados UMA vez cada: esquecimento
/// do índice (`autofetch-terminal.ts:95`), retenção solta (`:96-97`) e represa
/// (`:104-107`).
#[tokio::test]
async fn colapso_por_progresso_solta_retencao_e_esquece_o_indice_uma_vez() {
    let _serial = test_lock().await;
    let kv = kv();
    let now = now_ms();
    let policy = policy();
    let hash = hash_of(4);
    let imdb = "tt8888888";
    let mut lot = lot(&hash, now);
    lot.transfers.insert(hash.clone(), TRANSFER.to_string());
    lot.season_hints.insert(
        hash.clone(),
        SeasonHint {
            imdb_id: Some(imdb.to_string()),
            season: Some(1),
            title: "Pack Completo DUBLADO".to_string(),
        },
    );
    write(&kv, &lot, policy, now).unwrap();
    // Retenção viva das duas camadas que as guardas de limpeza leem.
    for key in [
        format!("adhold:v1:{ACCOUNT}:{hash}"),
        format!("adprot:v1:{ADAPTER}:{ACCOUNT}:{hash}"),
    ] {
        kv.put_json(&key, &serde_json::json!({"at": now}), 600, now)
            .unwrap();
    }

    let seen: Arc<Mutex<Vec<Op>>> = Arc::new(Mutex::new(Vec::new()));
    register(Arc::new({
        let seen = Arc::clone(&seen);
        move |op: Op| {
            seen.lock().unwrap().push(op);
            Ok(0usize)
        }
    })
        as Arc<dyn Fn(Op) -> Result<usize, Refuse> + Send + Sync>);

    // Baseline + `stall_streak` passagens paradas: colapsa na última.
    let mut collapses = 0;
    for _ in 0..=policy.stall_streak {
        let debrid = debrid_with(&hash, evidence(1_000.0, 0.0));
        let report = step(&kv, policy, &debrid, true, SEARCH, now).await.unwrap();
        collapses += usize::from(report.terminal);
        assert!(report.suppressed <= 1);
    }
    clear();

    assert_eq!(collapses, 1, "colapso uma única vez");
    let forgets: Vec<(String, String)> = seen
        .lock()
        .unwrap()
        .iter()
        .filter_map(|op| match op {
            Op::Forget { imdb_id, hash } if hash == &hash_of(4) => {
                Some((imdb_id.clone(), hash.clone()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        forgets,
        vec![(imdb.to_string(), hash.clone())],
        "um único forget, com a obra vinda do hint"
    );
    assert!(
        !kv.forget(&format!("adhold:v1:{ACCOUNT}:{hash}")).unwrap(),
        "hold volátil já solto pelo colapso"
    );
    assert!(
        !kv.forget(&format!("adprot:v1:{ADAPTER}:{ACCOUNT}:{hash}"))
            .unwrap(),
        "proteção durável já solta pelo colapso"
    );
    // A represa guarda a chave com id e TTL do lote.
    let sup_key = format!("autofetch:v3:sup:{ADAPTER}:{ACCOUNT}:{hash}");
    assert!(kv.get_json(&sup_key, now).unwrap().is_some());
}

/// Fail-safe: serviço que NÃO publica progresso (TorBox/Real-Debrid) nunca é
/// condenado pela derivação — `progress: None` é `NoSignal`
/// (`autofetch-progress.ts:65-67`).
#[tokio::test]
async fn servico_sem_progresso_nunca_e_condenado_pela_derivacao() {
    let kv = kv();
    let now = now_ms();
    let policy = policy();
    let hash = hash_of(5);
    write(&kv, &lot(&hash, now), policy, now).unwrap();

    for _ in 0..=policy.stall_streak * 3 {
        let debrid = FakeDebrid::accepting().state(&hash, "downloading");
        let report = step(&kv, policy, &debrid, true, SEARCH, now).await.unwrap();
        assert!(!report.terminal, "sem progresso medido não há prova");
    }
    let saved = read(&kv, SEARCH, now).unwrap().unwrap();
    assert!(
        !saved.progress.contains_key(&hash),
        "memória intocada sem sinal"
    );
    // E a chave da represa não existe: nada foi represado.
    assert!(SuppressedV3::new(&kv)
        .read(ADAPTER, ACCOUNT, &hash, now)
        .unwrap()
        .is_none());
}
