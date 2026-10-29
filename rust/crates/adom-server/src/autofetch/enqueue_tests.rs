//! Testes do enfileiramento: cascata → portões → fila (escritor único), com o
//! `deferred` SEMPRE preservado e o hold solto no fim.

use adom_autofetch::v3::QueueV3;
use adom_index::NativeKv;
use adom_sources::now_ms;
use serde_json::json;

use super::super::enqueue_items::{candidate_of, parse_items};
use super::super::fakes::{batch_payload, job, FakeDebrid, SCOPE};
use super::super::Policy;
use super::{run, Holds};

const SEARCH: &str = "tt1234567:1:2";
const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta-de-teste";

fn hash_of(n: u32) -> String {
    format!("{n:040x}")
}

fn kv() -> NativeKv {
    NativeKv::open_memory().unwrap()
}

fn marker(kv: &NativeKv, hash: &str, now: i64) -> bool {
    QueueV3::new(kv)
        .marker(ADAPTER, ACCOUNT, hash, now)
        .unwrap()
        .is_some()
}

fn queued(kv: &NativeKv, now: i64) -> Vec<String> {
    QueueV3::new(kv)
        .read_queue(SEARCH, now)
        .unwrap()
        .into_iter()
        .map(|candidate| candidate.info_hash)
        .collect()
}

#[tokio::test]
async fn lote_aceito_grava_fila_marker_e_enfileira() {
    let kv = kv();
    let now = now_ms();
    let holds = Holds::default();
    // Config PINADA: os testes de env escrevem no processo em paralelo.
    kv.put_json("cfg:v1:autofetch", &json!({ "autoFetchMax": 3 }), 600, now)
        .unwrap();
    let debrid = FakeDebrid::accepting();
    let payload = batch_payload(SEARCH, &[(&hash_of(1), true), (&hash_of(2), true)]);
    let report = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, payload),
        now,
    )
    .await
    .unwrap();

    assert!(report.refused.is_none());
    assert_eq!(report.enqueued.len(), 2);
    assert_eq!(report.attempts, 2);
    assert_eq!(report.deferred, 0);
    assert_eq!(debrid.accepted(), vec![hash_of(1), hash_of(2)]);
    // Fila = tentativas, e cada aceite tem marker (o dreno não repete).
    assert_eq!(queued(&kv, now), vec![hash_of(1), hash_of(2)]);
    assert!(marker(&kv, &hash_of(1), now));
    assert!(marker(&kv, &hash_of(2), now));
    // Nada preso depois do lote.
    assert_eq!(holds.len(), 0);
    // O id do transfer viaja para o lote de recheck.
    assert_eq!(report.enqueued[0].1, Some(format!("id-{}", hash_of(1))));
}

/// O `deferred` (vaga esgotada) NUNCA se perde: fila = `attempts ∪ deferred`.
#[tokio::test]
async fn adiado_fica_na_fila_mesmo_sem_tentar() {
    let kv = kv();
    let now = now_ms();
    let hashes: Vec<String> = (1..=5).map(hash_of).collect();
    // O teste cobra o `autoFetchMax = 3` do default: PINADO no overlay para
    // não depender do env do processo (outros testes o escrevem em paralelo).
    kv.put_json("cfg:v1:autofetch", &json!({ "autoFetchMax": 3 }), 600, now)
        .unwrap();
    let items: Vec<(&str, bool)> = hashes.iter().map(|hash| (hash.as_str(), true)).collect();
    let debrid = FakeDebrid::accepting();
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &debrid,
        &job(SCOPE, batch_payload(SEARCH, &items)),
        now,
    )
    .await
    .unwrap();

    // `autoFetchMax = 3`: duas vagas sobram como adiadas, não como descarte.
    assert_eq!(report.attempts, 3);
    assert_eq!(report.deferred, 2);
    assert_eq!(report.dropped, 0);
    assert_eq!(report.skips.get("search-slot-busy"), Some(&2));
    assert_eq!(queued(&kv, now), hashes);
    assert_eq!(report.queue_len, 5);
}

#[tokio::test]
async fn cache_desconhecido_nao_escreve_nem_apaga_a_fila() {
    let kv = kv();
    let now = now_ms();
    // Backup anterior: é o único que existe quando o cache é desconhecido.
    QueueV3::new(&kv)
        .write_queue(
            SEARCH,
            &[adom_autofetch::v3::QueueCandidate {
                info_hash: hash_of(9),
                ..Default::default()
            }],
            600,
            12,
            Some((ADAPTER, ACCOUNT)),
            now,
        )
        .unwrap();
    let debrid = FakeDebrid::unknown_cache();
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &debrid,
        &job(SCOPE, batch_payload(SEARCH, &[(&hash_of(1), true)])),
        now,
    )
    .await
    .unwrap();

    assert_eq!(report.refused, Some("unknown-cache"));
    assert!(debrid.accepted().is_empty());
    assert_eq!(queued(&kv, now), vec![hash_of(9)]);
    assert!(!marker(&kv, &hash_of(1), now));
}

#[tokio::test]
async fn marker_ativo_barra_o_enqueue_sem_tirar_da_fila() {
    let kv = kv();
    let now = now_ms();
    let hash = hash_of(1);
    QueueV3::new(&kv)
        .set_marker(
            ADAPTER,
            ACCOUNT,
            &hash,
            &json!({ "id": "antigo" }),
            600,
            now,
        )
        .unwrap();
    let debrid = FakeDebrid::accepting();
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &debrid,
        &job(SCOPE, batch_payload(SEARCH, &[(&hash, true)])),
        now,
    )
    .await
    .unwrap();

    assert_eq!(report.skips.get("marker"), Some(&1));
    assert!(debrid.accepted().is_empty(), "não enfileira duas vezes");
    // O dreno ainda precisa ver o candidato: ele continua na fila.
    assert_eq!(queued(&kv, now), vec![hash]);
}

#[tokio::test]
async fn falha_de_enqueue_mantem_hash_na_fila_sem_marker() {
    let kv = kv();
    let now = now_ms();
    let hash = hash_of(1);
    let mut debrid = FakeDebrid::accepting();
    debrid.accept = false;
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &debrid,
        &job(SCOPE, batch_payload(SEARCH, &[(&hash, true)])),
        now,
    )
    .await
    .unwrap();

    assert_eq!(report.skips.get("enqueue-error"), Some(&1));
    assert!(report.enqueued.is_empty());
    assert_eq!(queued(&kv, now), vec![hash.clone()]);
    assert!(!marker(&kv, &hash, now));
}

#[tokio::test]
async fn dublado_br_ja_em_cache_nao_gera_tentativa() {
    let kv = kv();
    let now = now_ms();
    let hash = hash_of(1);
    let debrid = FakeDebrid::accepting().cached(&hash);
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &debrid,
        &job(SCOPE, batch_payload(SEARCH, &[(&hash, true)])),
        now,
    )
    .await
    .unwrap();

    assert_eq!(report.attempts, 0);
    assert_eq!(report.skips.get("already-cached"), Some(&1));
    assert!(debrid.accepted().is_empty());
    assert!(queued(&kv, now).is_empty());
}

#[tokio::test]
async fn lote_sem_search_key_ou_sem_escopo_recusa_sem_escrita() {
    let kv = kv();
    let now = now_ms();
    let debrid = FakeDebrid::accepting();

    for (scope, payload) in [
        (SCOPE, batch_payload("", &[(&hash_of(1), true)])),
        ("sem-escopo", batch_payload(SEARCH, &[(&hash_of(1), true)])),
        (SCOPE, batch_payload(SEARCH, &[])),
    ] {
        let report = run(
            &kv,
            Policy::fixture(),
            &Holds::default(),
            false,
            &debrid,
            &job(scope, payload),
            now,
        )
        .await
        .unwrap();
        assert!(report.refused.is_some());
    }
    assert!(debrid.accepted().is_empty());
    assert!(kv.keys_matching("autofetch", now).unwrap().is_empty());
}

#[tokio::test]
async fn falha_da_checagem_solta_o_hold_e_devolve_erro() {
    let kv = kv();
    let now = now_ms();
    let holds = Holds::default();
    let mut debrid = FakeDebrid::accepting();
    debrid.fail_check = true;
    let error = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, batch_payload(SEARCH, &[(&hash_of(1), true)])),
        now,
    )
    .await
    .unwrap_err();

    assert!(error.contains("checagem"));
    assert_eq!(holds.len(), 0, "hold não pode vazar na falha");
}

/// Invariante 6: `adrm:v1` VIVO sai dos candidatos ANTES dos pools, com o rótulo
/// `adrm` — e esta porta só LÊ: a marca sai intacta.
#[tokio::test]
async fn hash_com_marca_adrm_sai_antes_dos_pools() {
    let kv = kv();
    let now = now_ms();
    let blocked = hash_of(1);
    let free = hash_of(2);
    let key = adom_debrid::alldebrid_cleanup::adrm_key(ACCOUNT, &blocked);
    let mark = json!({ "at": now });
    kv.put_json(&key, &mark, 3_600, now).unwrap();
    let debrid = FakeDebrid::accepting();
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &debrid,
        &job(
            SCOPE,
            batch_payload(SEARCH, &[(&blocked, true), (&free, true)]),
        ),
        now,
    )
    .await
    .unwrap();

    assert_eq!(report.skips.get("adrm"), Some(&1));
    let accepted = debrid.accepted();
    assert_eq!(accepted, vec![free.clone()], "adrm não vai ao upload");
    assert_eq!(queued(&kv, now), vec![free]);
    assert!(!marker(&kv, &blocked, now));
    // Nem reescrita nem renovada: a marca de 1h caiu exatos 10 min.
    assert_eq!(
        kv.remaining_seconds(&key, now + 600_000).unwrap(),
        Some(3_000)
    );
}

/// Pool global desligado (pelo overlay do painel, sem mexer em env global) não
/// encosta no BR.
#[tokio::test]
async fn pool_global_desligado_nao_para_o_br() {
    let kv = kv();
    let now = now_ms();
    let holds = Holds::default();
    let br = hash_of(1);
    let any = hash_of(2);
    let off = json!({ "autoFetchAnyDubbed": false });
    kv.put_json("cfg:v1:autofetch", &off, 600, now).unwrap();
    let debrid = FakeDebrid::accepting();
    let report = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, batch_payload(SEARCH, &[(&br, true), (&any, false)])),
        now,
    )
    .await
    .unwrap();

    assert_eq!(report.attempts, 1);
    assert_eq!(debrid.accepted(), vec![br.clone()], "só o BR é tentado");
    assert_eq!(queued(&kv, now), vec![br]);
    assert_eq!(holds.len(), 0, "o pool desligado não vaza hold");
}

#[test]
fn parser_usa_prova_de_audio_br_e_veto_de_mentira() {
    let payload = json!({"items": [
        {"infoHash": "a", "_br": true, "_dubClaim": true},
        {"infoHash": "b", "_br": true, "_bankDub": true},
        {"infoHash": "c", "_br": true, "_dubbed": true, "_lied": true},
        {"infoHash": "d", "_br": false, "_dubbed": true}
    ]});
    let items = parse_items(payload.as_object().unwrap());
    assert_eq!(items[0].pool(), adom_autofetch::v3::CascadePool::Br);
    assert_eq!(items[1].pool(), adom_autofetch::v3::CascadePool::Br);
    assert_eq!(items[2].pool(), adom_autofetch::v3::CascadePool::Seeds);
    assert_eq!(items[3].pool(), adom_autofetch::v3::CascadePool::Any);
    assert!(!items[2].is_br_dubbed_proven());

    let candidate = candidate_of(
        &adom_autofetch::v3::CascadeAttempt {
            info_hash: "b".into(),
            pool: adom_autofetch::v3::CascadePool::Br,
            quality: None,
            slot_limit: None,
            rare: false,
            overflow: false,
        },
        &items[1],
        payload.as_object().unwrap(),
        1,
    );
    assert_eq!(candidate.bank_dub, Some(true));
    assert_eq!(candidate.lied, Some(false));
}

#[test]
fn parser_exclui_fallback_nao_fetchable_e_pack_multiobra() {
    let payload = json!({"items": [
        {"infoHash": "a", "_fromFallback": true, "_fallbackFetchable": false},
        {"infoHash": "b", "_fromFallback": true, "_fallbackFetchable": true},
        {"infoHash": "c", "_multiWorkAdmitted": true}
    ]});
    let items = parse_items(payload.as_object().unwrap());
    assert_eq!(
        items
            .iter()
            .map(|item| item.info_hash.as_str())
            .collect::<Vec<_>>(),
        ["b"]
    );
}
