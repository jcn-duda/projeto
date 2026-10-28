//! Boletim `cfg:v1:autofetch` lido a CADA passagem (P1/P2/P3).
//!
//! O contrato provado aqui é o do laço, não o do parser: o `Engine` nasce por
//! [`engine_for_pass`] — a MESMA função que a thread chama a cada volta —, então
//! um valor herdado do boot (ou uma leitura só no boot) quebra estes casos.
//!
//! `std::env` é GLOBAL: os casos de precedência seguram o `build::test_lock` e
//! devolvem o ambiente no `Drop`.

use std::collections::BTreeMap;
use std::sync::Arc;

use adom_autofetch::v3::QueueV3;
use adom_index::NativeKv;
use adom_sources::now_ms;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use super::super::build::test_lock;
use super::super::fakes::{batch_payload, factory_for, job, job_of, no_factory, FakeDebrid, SCOPE};
use super::super::probe_step::{self, ProbeSkipReason, ProbeStep};
use super::super::season_step;
use super::super::worker::live::LIVE_KEY;
use super::super::Policy;
use super::{engine_for_pass, Control, DebridFactory, Message};
use crate::tail_effects::SEASON_KEY;

const SEARCH: &str = "tt1234567:1:2";
const SEARCH2: &str = "tt7654321:1:1";
const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta-de-teste";

fn hash_of(n: u32) -> String {
    format!("{n:040x}")
}

/// Env controlada: lock global + restauração no fim do escopo.
struct Env {
    /// Só existe para manter o guard vivo; o nome com `_` cala o `dead_code`.
    _lock: std::sync::MutexGuard<'static, ()>,
    saved: Vec<(&'static str, Option<String>)>,
}

impl Env {
    /// Limpa as chaves ANTES do caso: o default de cada uma não vaza entre testes.
    fn new(keys: &[&'static str]) -> Self {
        let lock = test_lock();
        let saved = keys
            .iter()
            .map(|key| (*key, std::env::var(key).ok()))
            .collect();
        for key in keys {
            std::env::remove_var(key);
        }
        Self { _lock: lock, saved }
    }

    fn set(&self, key: &str, value: &str) {
        std::env::set_var(key, value);
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(raw) => std::env::set_var(key, raw),
                None => std::env::remove_var(key),
            }
        }
    }
}

fn probe_payload() -> Map<String, Value> {
    json!({ "imdbId": "tt0111161", "type": "movie" })
        .as_object()
        .expect("objeto")
        .clone()
}

fn season_payload() -> Map<String, Value> {
    json!({
        "adapter_id": ADAPTER,
        "account": ACCOUNT,
        "imdb": "tt0903747",
        "season": 2,
        "cache_key": "streams:v21:busca",
    })
    .as_object()
    .expect("objeto")
    .clone()
}

/// UMA passagem pelo caminho de produção (`engine_for_pass` + `run_once`).
/// Devolve os skips da passagem; erro de passagem reprova o caso na hora.
async fn run_pass(
    kv: &NativeKv,
    base: &Policy,
    factory: &DebridFactory,
    control: &Control,
    rx: &mut mpsc::Receiver<Message>,
    now: i64,
) -> BTreeMap<String, usize> {
    let engine = engine_for_pass(kv, base, None, factory, control, None, now);
    let pass = engine.run_once(rx, now).await;
    assert!(pass.errors.is_empty(), "{:?}", pass.errors);
    pass.skips
}

/// P1 — pausa SÓ no painel (`control.paused()` falso) faz a passagem pular, e o
/// lote volta a rodar quando o overlay é removido.
///
/// Cada passagem é um `engine_for_pass` novo: é exatamente o que o laço faz, e é
/// o que prova que o boletim não vem congelado do boot.
#[tokio::test]
async fn pausa_do_painel_vale_na_passagem_seguinte() {
    let kv = NativeKv::open_memory().expect("kv");
    let now = now_ms();
    let base = Policy::fixture();
    // A admin do gateway NÃO está pausada: quem pausa é o painel.
    let control = Control::new(false, 60_000);
    let factory = factory_for(SCOPE, Arc::new(FakeDebrid::accepting()));
    let (tx, mut rx) = mpsc::channel(4);

    kv.put_json(LIVE_KEY, &json!({ "paused": true }), 600, now)
        .expect("grava overlay");
    tx.try_send(Message::Batch(job(
        SCOPE,
        batch_payload(SEARCH, &[(&hash_of(1), true)]),
    )))
    .unwrap();

    let engine = engine_for_pass(&kv, &base, None, &factory, &control, None, now);
    let pass = engine.run_once(&mut rx, now).await;
    assert_eq!(pass.enqueued, 0, "painel pausado: nada é enfileirado");
    assert_eq!(pass.skips.get("paused"), Some(&1), "{:?}", pass.skips);
    assert!(
        !control.paused(),
        "a pausa é do painel; a admin do gateway continua retomável"
    );
    assert_eq!(
        QueueV3::new(&kv).read_queue(SEARCH, now).unwrap().len(),
        1,
        "o lote pausado é ADIADO, não perdido"
    );

    // Overlay removido (`reset()` do painel): a passagem seguinte volta a rodar.
    kv.forget(LIVE_KEY).expect("apaga overlay");
    tx.try_send(Message::Batch(job(
        SCOPE,
        batch_payload(SEARCH2, &[(&hash_of(2), true)]),
    )))
    .unwrap();

    let engine = engine_for_pass(&kv, &base, None, &factory, &control, None, now);
    let pass = engine.run_once(&mut rx, now).await;
    assert_eq!(pass.enqueued, 1, "sem overlay o lote volta a rodar");
    assert!(!pass.skips.contains_key("paused"), "{:?}", pass.skips);
    assert!(pass.errors.is_empty(), "{:?}", pass.errors);
}

/// P2 — `autoFetchBrProbe` do painel desliga a sonda mesmo com o `.env` ligado,
/// e liga mesmo com o `.env` desligado. A régua é a do passo (`plan`), não só o
/// campo: o motivo que o painel conta é `disabled`.
#[test]
fn sonda_do_painel_vence_o_env() {
    let env = Env::new(&["AUTOFETCH_BR_PROBE", "RELEASE_INDEX"]);
    let kv = NativeKv::open_memory().expect("kv");
    let now = now_ms();
    let base = Policy::fixture();
    let control = Control::new(false, 60_000);
    let factory = no_factory();
    // Sem `RELEASE_INDEX` a sonda pararia antes (`release-index-off`): o caso
    // precisa do índice ligado para medir só o toggle.
    env.set("RELEASE_INDEX", "true");

    let probe_config = |kv: &NativeKv, now: i64| {
        let engine = engine_for_pass(kv, &base, None, &factory, &control, None, now);
        engine.probe_config(false, 0, 200)
    };

    // `.env` LIGADO + painel DESLIGADO → desliga (live > env).
    env.set("AUTOFETCH_BR_PROBE", "true");
    kv.put_json(LIVE_KEY, &json!({ "autoFetchBrProbe": false }), 600, now)
        .expect("grava overlay");
    let config = probe_config(&kv, now);
    assert!(
        !config.probe.auto_fetch_br_probe,
        "o painel desligado venceu o .env ligado"
    );
    assert_eq!(
        probe_step::plan(&probe_payload(), None, &config, now),
        ProbeStep::Skip(ProbeSkipReason::Disabled),
        "a sonda tinha de recusar com `disabled`"
    );

    // `.env` DESLIGADO + painel LIGADO → liga (o painel vence nos dois sentidos).
    env.set("AUTOFETCH_BR_PROBE", "false");
    kv.put_json(LIVE_KEY, &json!({ "autoFetchBrProbe": true }), 600, now)
        .expect("grava overlay");
    let config = probe_config(&kv, now);
    assert!(
        config.probe.auto_fetch_br_probe,
        "o painel ligado venceu o .env desligado"
    );
    assert_ne!(
        probe_step::plan(&probe_payload(), None, &config, now),
        ProbeStep::Skip(ProbeSkipReason::Disabled),
        "ligado não pode recusar por `disabled`"
    );

    // Sem override nenhum o `.env` volta a mandar — nada de valor herdado.
    kv.forget(LIVE_KEY).expect("apaga overlay");
    assert!(
        !probe_config(&kv, now).probe.auto_fetch_br_probe,
        "sem boletim vale o .env"
    );
}

/// P3 — `autoFetchSeasonFill` do painel desliga o REGISTRO da temporada na
/// passagem seguinte (mesmo com `.env` ligado) e o liga com `.env` desligado.
///
/// Mede pelo laço inteiro: `Message::Batch` → `season` → `plan`/`execute`.
#[tokio::test]
async fn season_fill_do_painel_vence_o_env() {
    let env = Env::new(&["DEBRID_AUTO_FETCH_SEASON_FILL"]);
    let kv = NativeKv::open_memory().expect("kv");
    let now = now_ms();
    let base = Policy::fixture();
    let control = Control::new(false, 60_000);
    let factory = no_factory();
    let (tx, mut rx) = mpsc::channel(4);
    let index = season_step::index_key(ADAPTER, ACCOUNT, "tt0903747", 2);

    // `.env` LIGADO + painel DESLIGADO → não registra (`fill-off`).
    env.set("DEBRID_AUTO_FETCH_SEASON_FILL", "true");
    kv.put_json(LIVE_KEY, &json!({ "autoFetchSeasonFill": false }), 600, now)
        .expect("grava overlay");
    tx.try_send(Message::Batch(job_of(SEASON_KEY, SCOPE, season_payload())))
        .unwrap();
    let skips = run_pass(&kv, &base, &factory, &control, &mut rx, now).await;
    assert_eq!(skips.get("fill-off"), Some(&1), "{skips:?}");
    assert!(
        kv.get_json(&index, now).expect("lê").is_none(),
        "toggle desligado no painel não pode gravar o índice"
    );

    // `.env` DESLIGADO + painel LIGADO → registra a busca da temporada.
    env.set("DEBRID_AUTO_FETCH_SEASON_FILL", "false");
    kv.put_json(LIVE_KEY, &json!({ "autoFetchSeasonFill": true }), 600, now)
        .expect("grava overlay");
    tx.try_send(Message::Batch(job_of(SEASON_KEY, SCOPE, season_payload())))
        .unwrap();
    let skips = run_pass(&kv, &base, &factory, &control, &mut rx, now).await;
    assert!(!skips.contains_key("fill-off"), "{skips:?}");
    assert!(
        kv.get_json(&index, now).expect("lê").is_some(),
        "painel ligado tinha de registrar a temporada"
    );
}
