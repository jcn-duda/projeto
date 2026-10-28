//! Testes do passo de dreno da represa (`autofetch:v3:sup:`).
//!
//! Os três contratos medidos aqui: (a) o `remove` usa o id da RELEITURA, nunca
//! o id lido no início da varredura; (b) entrada que deixou de ser represada
//! sai sem rede; (c) retenção viva (`adhold:`/`adprot:`) e backoff mantêm a
//! entrada — invariante 6 do `AGENTS.md`.

use std::sync::Arc;

use adom_autofetch::v3::{marker_value, suppressed_key, QueueV3, SuppressedV3};
use adom_index::NativeKv;
use serde_json::json;

use super::{clear, drain, read_one, test_lock};
use crate::autofetch::fakes::{factory_for, FakeDebrid, SCOPE};
use crate::autofetch::ports::{DebridFactory, DebridIo};

const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta-de-teste";
const TTL: i64 = 600;

/// `writes` no KV no formato do Node (`{id, at, fails, nextAt}`).
fn note(kv: &NativeKv, hash: &str, id: &str, now: i64) {
    SuppressedV3::new(kv)
        .note(ADAPTER, ACCOUNT, hash, id, TTL, now)
        .unwrap();
}

/// Serviço de mentira + o mesmo adaptador como `DebridIo` (para a fábrica).
fn fake() -> (Arc<FakeDebrid>, DebridIo) {
    let fake = Arc::new(FakeDebrid::accepting());
    let io: DebridIo = fake.clone();
    (fake, io)
}

#[test]
fn escopo_do_dublê_bate_com_a_chave_da_represa() {
    // A fábrica é consultada com `adapter:account`; se o dublê divergir do que
    // os testes gravam, todo dreno viraria `kept` por falta de credencial.
    assert_eq!(SCOPE, format!("{ADAPTER}:{ACCOUNT}"));
}

#[tokio::test]
async fn dreno_apaga_o_id_atual_e_nao_o_lido_no_inicio() {
    // `drain` publica o último passo num registro do PROCESSO: os testes que o
    // chamam se serializam.
    let _guard = test_lock().await;
    clear();
    let now = adom_sources::now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    let hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    note(&kv, hash, "id-antigo", now);
    let (fake, io) = fake();
    // A fábrica roda ANTES da releitura do passo e troca o id no KV: quem
    // apagar o id da primeira leitura falha aqui.
    let factory: DebridFactory = {
        let kv = Arc::clone(&kv);
        Arc::new(move |_asked: &str| {
            note(&kv, hash, "id-novo", now);
            Some(Arc::clone(&io))
        })
    };

    let report = drain(&kv, factory, 10, now).await.unwrap();

    assert_eq!(fake.removed(), vec!["id-novo".to_string()]);
    assert_eq!(report.operations, 1);
    assert_eq!(report.counters.dropped, 1);
    assert_eq!(report.counters.failed, 0);
    assert_eq!(report.counters.retried, 0);
    assert_eq!(report.depth, 0);
}

#[tokio::test]
async fn entrada_que_deixou_de_ser_represada_sai_da_represa() {
    let _guard = test_lock().await;
    clear();
    let now = adom_sources::now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    // Órfã: registro sem `id` não é remoção represada.
    let orphan = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    kv.put_json(
        &suppressed_key(ADAPTER, ACCOUNT, orphan),
        &json!({ "at": now }),
        TTL,
        now,
    )
    .unwrap();
    // Já removida por outro ator (`adrm:v1:`): sai sem chamar o serviço.
    let gone = "cccccccccccccccccccccccccccccccccccccccc";
    note(&kv, gone, "id-gone", now);
    kv.put_json(&format!("adrm:v1:{ACCOUNT}:{gone}"), &json!(now), TTL, now)
        .unwrap();
    let (fake, io) = fake();

    let report = drain(&kv, factory_for(SCOPE, io), 10, now).await.unwrap();

    assert!(fake.removed().is_empty(), "{:?}", fake.removed());
    assert_eq!(report.operations, 0);
    assert_eq!(report.counters.dropped, 2);
    assert_eq!(report.counters.kept, 0);
    assert_eq!(report.depth, 0);
}

#[tokio::test]
async fn entrada_defendida_por_posse_ou_retencao_nao_sai() {
    let _guard = test_lock().await;
    clear();
    let now = adom_sources::now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    // Hold volátil + marker com meta: `pool`/`obra` do registro vêm do marker.
    let held = "dddddddddddddddddddddddddddddddddddddddd";
    note(&kv, held, "id-held", now);
    let meta = json!({ "pool": "br", "obra": "tt1234567" });
    QueueV3::new(&kv)
        .set_marker(
            ADAPTER,
            ACCOUNT,
            held,
            &marker_value(true, Some("id-held"), Some(&meta), now),
            TTL,
            now,
        )
        .unwrap();
    kv.put_json(
        &format!("adhold:v1:{ACCOUNT}:{held}"),
        &json!({ "until": now + 60_000 }),
        TTL,
        now,
    )
    .unwrap();
    // Retenção durável do pool BR (`adprot:v1:`).
    let protected = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    note(&kv, protected, "id-prot", now);
    kv.put_json(
        &format!("adprot:v1:{ADAPTER}:{ACCOUNT}:{protected}"),
        &json!({ "acceptedAt": now, "readyAt": now }),
        TTL,
        now,
    )
    .unwrap();
    // Backoff vivo: o registro já agendou a própria espera.
    let backoff = "ffffffffffffffffffffffffffffffffffffffff";
    kv.put_json(
        &suppressed_key(ADAPTER, ACCOUNT, backoff),
        &json!({ "id": "id-wait", "at": now, "fails": 2, "nextAt": now + 60_000 }),
        TTL,
        now,
    )
    .unwrap();

    // Campo a campo: id atual, tentativas, `nextAt`, motivo, obra/hash.
    let pressed = read_one(&kv, ADAPTER, ACCOUNT, held, now).unwrap().unwrap();
    assert_eq!(pressed.adapter, ADAPTER);
    assert_eq!(pressed.account, ACCOUNT);
    assert_eq!(pressed.hash, held);
    assert_eq!(pressed.id, "id-held");
    assert_eq!(pressed.tries, 0);
    assert_eq!(pressed.next_at, 0);
    assert_eq!(pressed.motive, "protected");
    assert_eq!(pressed.pool, "br");
    assert_eq!(pressed.obra, "tt1234567");
    let waiting = read_one(&kv, ADAPTER, ACCOUNT, backoff, now)
        .unwrap()
        .unwrap();
    assert_eq!(waiting.tries, 2);
    assert_eq!(waiting.motive, "backoff");
    assert_eq!(waiting.next_at, now + 60_000);

    let (fake, io) = fake();
    let report = drain(&kv, factory_for(SCOPE, io), 10, now).await.unwrap();

    assert!(fake.removed().is_empty(), "{:?}", fake.removed());
    assert_eq!(report.operations, 0);
    assert_eq!(report.counters.kept, 3);
    assert_eq!(report.counters.dropped, 0);
    assert_eq!(report.depth, 3);
}
