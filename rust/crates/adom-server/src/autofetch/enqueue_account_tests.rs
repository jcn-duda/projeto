//! Testes do memo da sonda de conta (P5) — janela, valor, erro e KV ilegível.

use adom_index::NativeKv;
use serde_json::json;

use super::{account_key, probe, read, AccountMemo};
use crate::autofetch::enqueue::{run, Holds};
use crate::autofetch::fakes::{batch_payload, job, FakeDebrid, SCOPE};
use crate::autofetch::Policy;

const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta-de-teste";
const PREFIX: &str = "autofetch-worker:v1:account:";
const SEARCH: &str = "tt1234567:1:2";
/// Default de `DEBRID_AUTO_FETCH_PAUSE_REFRESH_MS` (`src/config/debrid.ts:285`).
const DEFAULT_REFRESH: i64 = 900_000;

fn kv() -> NativeKv {
    NativeKv::open_memory().unwrap()
}

fn serving(used: Option<u64>) -> FakeDebrid {
    FakeDebrid {
        known: true,
        accept: true,
        account_used: used,
        ..FakeDebrid::default()
    }
}

/// (a) default: 15 min de janela. Dentro dela o memo responde (uma chamada ao
/// serviço para várias leituras); ao vencer, pergunta de novo.
#[tokio::test]
async fn memo_usa_a_janela_default_de_quinze_minutos() {
    let kv = kv();
    let now = 1_800_000_000_000;
    let debrid = serving(Some(1_500));

    assert_eq!(
        probe(&kv, ADAPTER, ACCOUNT, &debrid, DEFAULT_REFRESH, now).await,
        Some(1_500)
    );
    assert_eq!(
        probe(
            &kv,
            ADAPTER,
            ACCOUNT,
            &debrid,
            DEFAULT_REFRESH,
            now + 899_999
        )
        .await,
        Some(1_500)
    );
    assert_eq!(debrid.account_calls(), 1, "dentro da janela não repete");

    assert_eq!(
        probe(
            &kv,
            ADAPTER,
            ACCOUNT,
            &debrid,
            DEFAULT_REFRESH,
            now + DEFAULT_REFRESH
        )
        .await,
        Some(1_500)
    );
    assert_eq!(debrid.account_calls(), 2, "janela vencida pergunta de novo");
}

/// (b) valor explícito: a janela do painel manda no memo, não o default.
#[tokio::test]
async fn memo_obedece_a_janela_explicita_do_painel() {
    let kv = kv();
    let now = 1_800_000_000_000;
    let debrid = serving(Some(10));
    let refresh = 1_000;

    assert_eq!(
        probe(&kv, ADAPTER, ACCOUNT, &debrid, refresh, now).await,
        Some(10)
    );
    assert_eq!(
        probe(&kv, ADAPTER, ACCOUNT, &debrid, refresh, now + 999).await,
        Some(10)
    );
    assert_eq!(debrid.account_calls(), 1, "999 ms ainda é fresco");
    assert_eq!(
        probe(&kv, ADAPTER, ACCOUNT, &debrid, refresh, now + refresh).await,
        Some(10)
    );
    assert_eq!(debrid.account_calls(), 2, "1 s venceu a janela explícita");
}

/// (c) inválido/negativo: `pauseRefreshMs <= 0` desliga o memo — o TS com
/// janela zero nunca considera o memo fresco, e nada é escrito no KV (TTL `<= 0`
/// lá é permanente).
#[tokio::test]
async fn janela_zero_desliga_o_memo_sem_escrever() {
    for refresh in [0, -5] {
        let kv = kv();
        let now = 1_800_000_000_000;
        let debrid = serving(Some(7));
        assert_eq!(
            probe(&kv, ADAPTER, ACCOUNT, &debrid, refresh, now).await,
            Some(7)
        );
        assert_eq!(
            probe(&kv, ADAPTER, ACCOUNT, &debrid, refresh, now).await,
            Some(7)
        );
        assert_eq!(debrid.account_calls(), 2, "sem memo, pergunta sempre");
        assert!(
            kv.keys_matching(PREFIX, now).unwrap().is_empty(),
            "janela zero não pode gravar memo permanente"
        );
    }
}

/// Erro do serviço NUNCA vira memo: a próxima leva pergunta de novo e nada fica
/// gravado.
#[tokio::test]
async fn erro_do_servico_nao_vira_memo() {
    let kv = kv();
    let now = 1_800_000_000_000;
    let debrid = FakeDebrid {
        known: true,
        accept: true,
        fail_account: true,
        ..FakeDebrid::default()
    };

    assert_eq!(
        probe(&kv, ADAPTER, ACCOUNT, &debrid, DEFAULT_REFRESH, now).await,
        None
    );
    assert_eq!(
        probe(&kv, ADAPTER, ACCOUNT, &debrid, DEFAULT_REFRESH, now).await,
        None
    );
    assert_eq!(debrid.account_calls(), 2, "erro não é cacheado");
    assert!(kv.keys_matching(PREFIX, now).unwrap().is_empty());
}

/// Serviço que não publica quota (`used: None`) também é veredito: memoiza para
/// não pagar a chamada de novo (o TS memoiza `blocked: false`).
#[tokio::test]
async fn servico_sem_quota_tambem_vira_memo() {
    let kv = kv();
    let now = 1_800_000_000_000;
    let debrid = serving(None);

    assert_eq!(
        probe(&kv, ADAPTER, ACCOUNT, &debrid, DEFAULT_REFRESH, now).await,
        None
    );
    assert_eq!(
        probe(&kv, ADAPTER, ACCOUNT, &debrid, DEFAULT_REFRESH, now).await,
        None
    );
    assert_eq!(debrid.account_calls(), 1);
    assert_eq!(
        read(&kv, ADAPTER, ACCOUNT, DEFAULT_REFRESH, now),
        AccountMemo::Fresh(None)
    );
}

/// Fail-open na LEITURA: memo sem forma conhecida (ou com `at` fora de inteiro)
/// é "ausente", e quem responde é o serviço.
#[tokio::test]
async fn memo_ilegivel_fail_open_para_o_servico() {
    let kv = kv();
    let now = 1_800_000_000_000;
    let key = account_key(ADAPTER, ACCOUNT);
    // Sem `used`: forma desconhecida — não dá para provar o uso medido.
    kv.put_json(&key, &json!({ "at": now }), 600, now).unwrap();
    assert_eq!(
        read(&kv, ADAPTER, ACCOUNT, DEFAULT_REFRESH, now),
        AccountMemo::Absent
    );
    kv.put_json(&key, &json!("lixo"), 600, now).unwrap();
    assert_eq!(
        read(&kv, ADAPTER, ACCOUNT, DEFAULT_REFRESH, now),
        AccountMemo::Absent
    );

    let debrid = serving(Some(99));
    assert_eq!(
        probe(&kv, ADAPTER, ACCOUNT, &debrid, DEFAULT_REFRESH, now).await,
        Some(99)
    );
    assert_eq!(debrid.account_calls(), 1, "memo ilegível não é resposta");
}

/// P5 na FIADA do lote: `enqueue::run` pergunta a conta no máximo UMA vez por
/// janela de `autoFetchPauseRefreshMs` — sem o memo, cada lote pagava uma
/// chamada de conta com `pauseAt` configurado.
#[tokio::test]
async fn lote_pergunta_a_conta_uma_vez_por_janela() {
    let kv = kv();
    let now = 1_800_000_000_000;
    kv.put_json(
        "cfg:v1:autofetch",
        &json!({
            "autoFetchBr": true,
            "autoFetchMax": 3,
            "autoFetchPauseAt": 2000,
            "autoFetchPauseRefreshMs": 60_000,
            "autoFetchQueue": false
        }),
        600,
        now,
    )
    .unwrap();
    let debrid = serving(None);
    let hash = "0".repeat(40);
    for at in [now, now + 59_999, now + 60_000] {
        run(
            &kv,
            Policy::fixture(),
            &Holds::default(),
            false,
            &debrid,
            &job(SCOPE, batch_payload(SEARCH, &[(&hash, true)])),
            at,
        )
        .await
        .unwrap();
    }
    assert_eq!(
        debrid.account_calls(),
        2,
        "uma pergunta por janela de 60 s (a 3ª leva venceu o memo)"
    );
}
