//! Testes do teto por OBRA do lote (`autofetch-obra.ts` no oráculo).
//!
//! Cada régua tem três provas: (a) o DEFAULT do TS, (b) valor explícito e
//! (c) valor inválido/negativo. Os defaults de `autoFetchTtl` e
//! `autoFetchRareMax` ficam em `enqueue_gates_tests.rs` (são lidos no
//! `LivePolicy`); aqui ficam o PORTÃO (fecha a segunda busca da mesma obra), a
//! JANELA, o lease, o registro do aceite e o regime raro.

use crate::autofetch::enqueue::{run, Holds};
use crate::autofetch::enqueue_items::{parse_items, Item};
use crate::autofetch::fakes::{job, FakeDebrid, SCOPE};
use crate::autofetch::Policy;
use adom_autofetch::v3::{ObraStoreV3, QueueV3};
use adom_core::{obra_identity, obra_key};
use adom_index::NativeKv;
use serde_json::{json, Map, Value};

use super::{identity, refuse, Gate};

const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta-de-teste";
const IMDB: &str = "tt1234567";
/// Instante fixo: janela e TTL do KV ficam determinísticos.
const NOW: i64 = 1_800_000_000_000;

fn kv() -> NativeKv {
    NativeKv::open_memory().unwrap()
}

fn hash_of(n: u32) -> String {
    format!("{n:040x}")
}

/// Boletim do painel (`cfg:v1:autofetch`) — vence o `.env` nos dois lados.
fn overlay(kv: &NativeKv, value: Value) {
    kv.put_json("cfg:v1:autofetch", &value, 86_400, NOW)
        .unwrap();
}

fn item(hash: &str, br: bool, dubbed: bool) -> Value {
    json!({
        "infoHash": hash,
        "title": "Titulo de Teste",
        "name": "Titulo de Teste 1080p",
        "_quality": "1080p",
        "_seeders": 40,
        "_br": br,
        "_dubbed": dubbed
    })
}

/// Candidato do pool `seeds` no regime RARO (`pickSeedsPool`).
///
/// `_slotLimit` fica ABAIXO de `rareMax` de propósito: `seedsRare`
/// (`autofetch-obra.ts:170`) honra o booleano ANTES de inferir raro pelo slot
/// (`slotLimit >= rareMax`, linha 177), então só assim o teste isola a régua do
/// booleano em vez da inferência.
fn rare_item(hash: &str) -> Value {
    json!({
        "infoHash": hash,
        "title": "Titulo de Teste",
        "name": "Titulo de Teste 720p",
        "_quality": "720p",
        "_seeders": 3,
        "_br": false,
        "_dubbed": false,
        "_rare": true,
        "_slotLimit": 2
    })
}

fn payload(search: &str, episode: i64, items: Vec<Value>) -> Map<String, Value> {
    serde_json::from_value(json!({
        "searchKey": search,
        "imdbId": IMDB,
        "season": 1,
        "episode": episode,
        "items": items
    }))
    .unwrap()
}

fn queued(kv: &NativeKv, search: &str) -> Vec<String> {
    QueueV3::new(kv)
        .read_queue(search, NOW)
        .unwrap()
        .into_iter()
        .map(|candidate| candidate.info_hash)
        .collect()
}

/// Registro durável da obra para o pedido `(season, episode)`.
fn registro(kv: &NativeKv, payload: &Map<String, Value>) -> Vec<adom_core::ObraRecordEntry> {
    let items: Vec<Item> = parse_items(payload);
    let ident = identity(ADAPTER, ACCOUNT, payload, &items[0], true);
    ObraStoreV3::new(kv)
        .read(&obra_key(&obra_identity(&ident)), NOW)
        .unwrap()
}

/// Teto por obra (régua `autoFetchMax`): a SEGUNDA busca da mesma obra com
/// `autoFetchMax: 1` já encontra o portão fechado — o hash não sobe ao serviço,
/// mas continua na fila para o dreno.
#[tokio::test]
async fn teto_por_obra_fecha_a_segunda_busca_da_mesma_obra() {
    let kv = kv();
    overlay(&kv, json!({ "autoFetchMax": 1, "autoFetchTtl": 3_600 }));
    let debrid = FakeDebrid::accepting();
    let holds = Holds::default();
    let first = hash_of(1);
    let second = hash_of(2);

    let um = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, payload("k1", 2, vec![item(&first, true, true)])),
        NOW,
    )
    .await
    .unwrap();
    assert_eq!(um.enqueued.len(), 1, "primeira busca da obra passa");

    let dois = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, payload("k2", 2, vec![item(&second, true, true)])),
        NOW,
    )
    .await
    .unwrap();

    assert_eq!(dois.skips.get("obra-cap"), Some(&1), "teto por obra fecha");
    assert_eq!(dois.enqueued.len(), 0);
    assert_eq!(debrid.accepted(), vec![first], "o segundo hash não subiu");
    assert_eq!(queued(&kv, "k2"), vec![second], "o adiado fica na fila");
    assert_eq!(holds.len(), 0, "nem hold nem lease vazam");
}

/// Janela do teto (régua `autoFetchTtl`): vencida a janela, a MESMA obra abre
/// vaga de novo (`windowMs`, `autofetch-obra.ts:180`).
#[tokio::test]
async fn janela_do_teto_respeita_o_auto_fetch_ttl() {
    let kv = kv();
    overlay(&kv, json!({ "autoFetchMax": 1, "autoFetchTtl": 60 }));
    let debrid = FakeDebrid::accepting();
    let holds = Holds::default();

    let um = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, payload("k1", 2, vec![item(&hash_of(1), true, true)])),
        NOW,
    )
    .await
    .unwrap();
    assert_eq!(um.enqueued.len(), 1);

    // 61 s depois a vaga de 60 s já venceu: a obra aceita de novo.
    let dois = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, payload("k2", 2, vec![item(&hash_of(2), true, true)])),
        NOW + 61_000,
    )
    .await
    .unwrap();
    assert_eq!(dois.skips.get("obra-cap"), None, "janela vencida reabre");
    assert_eq!(dois.enqueued.len(), 1);
}

/// Lease: falha do enqueue devolve a vaga NA HORA (o `releaseObra` do catch).
/// Sem isso o lease de 60 s fecharia o teto de um pool com `autoFetchMax: 1`.
#[tokio::test]
async fn lease_volta_quando_o_enqueue_falha() {
    let kv = kv();
    overlay(&kv, json!({ "autoFetchMax": 1, "autoFetchTtl": 3_600 }));
    let holds = Holds::default();
    let mut debrid = FakeDebrid::accepting();
    debrid.accept = false;

    for (search, n) in [("k1", 1), ("k2", 2)] {
        let report = run(
            &kv,
            Policy::fixture(),
            &holds,
            false,
            &debrid,
            &job(
                SCOPE,
                payload(search, 2, vec![item(&hash_of(n), true, true)]),
            ),
            NOW,
        )
        .await
        .unwrap();
        assert_eq!(report.skips.get("enqueue-error"), Some(&1));
        assert_eq!(report.skips.get("obra-cap"), None, "lease devolvido");
    }
}

/// Registro durável do aceite (`commitObra`): hash, pool e id do transfer.
#[tokio::test]
async fn registro_do_aceite_guarda_hash_pool_e_transfer() {
    let kv = kv();
    // Janela pinada: o TTL do registro não pode depender do env do processo.
    overlay(&kv, json!({ "autoFetchTtl": 3_600 }));
    let debrid = FakeDebrid::accepting();
    let hash = hash_of(1);
    let pedido = payload("k1", 2, vec![item(&hash, true, true)]);
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &debrid,
        &job(SCOPE, pedido.clone()),
        NOW,
    )
    .await
    .unwrap();
    assert_eq!(report.enqueued.len(), 1);

    // O helper usa a MESMA identidade do lote (imdb + temporada + episódio).
    let registro = registro(&kv, &pedido);
    assert_eq!(registro.len(), 1);
    assert_eq!(registro[0].hash, hash);
    assert_eq!(registro[0].pool, "br");
    assert_eq!(registro[0].id, Some(format!("id-{hash}")));
    assert_eq!(registro[0].title.as_deref(), Some("Titulo de Teste"));
}

/// Regime RARO no teto: `rare` do lote sobe o cap do pool `seeds` de
/// `topSeedsMax` para `rareMax` (`poolCap`, `autofetch-obra.ts:161`).
#[tokio::test]
async fn raro_usa_o_rare_max_no_teto_da_obra() {
    let kv = kv();
    overlay(
        &kv,
        json!({ "autoFetchTopSeedsMax": 1, "autoFetchRareMax": 3, "autoFetchTtl": 3_600 }),
    );
    let debrid = FakeDebrid::accepting();
    let holds = Holds::default();
    let first = hash_of(1);
    let second = hash_of(2);

    let um = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, payload("k1", 2, vec![rare_item(&first)])),
        NOW,
    )
    .await
    .unwrap();
    assert_eq!(um.enqueued.len(), 1);

    let dois = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, payload("k2", 2, vec![rare_item(&second)])),
        NOW,
    )
    .await
    .unwrap();

    // Com o cap de `topSeedsMax` (1) a segunda seria `obra-cap`; com `rareMax`
    // (3) ainda há vaga.
    assert_eq!(dois.skips.get("obra-cap"), None, "raro usa rareMax");
    assert_eq!(debrid.accepted(), vec![first, second]);
}

/// Sem `rare` no lote o MESMO cenário fecha em `topSeedsMax`: prova que o cap
/// não é fixo em `rareMax`. O `slotLimit` vai a 1 porque a régua do TS
/// (`seedsRare`, `autofetch-obra.ts:170`) também infere raro quando o slot
/// carrega o valor de `rareMax` — é o caminho do dreno, que perde o booleano.
#[tokio::test]
async fn seeds_comum_usa_o_top_seeds_max_no_teto_da_obra() {
    let kv = kv();
    overlay(
        &kv,
        json!({ "autoFetchTopSeedsMax": 1, "autoFetchRareMax": 3, "autoFetchTtl": 3_600 }),
    );
    let debrid = FakeDebrid::accepting();
    let holds = Holds::default();
    let mut comum = rare_item(&hash_of(1));
    comum["_rare"] = json!(false);
    comum["_slotLimit"] = json!(1);

    let um = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, payload("k1", 2, vec![comum])),
        NOW,
    )
    .await
    .unwrap();
    assert_eq!(um.enqueued.len(), 1);

    let mut outro = rare_item(&hash_of(2));
    outro["_rare"] = json!(false);
    outro["_slotLimit"] = json!(1);
    let dois = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, payload("k2", 2, vec![outro])),
        NOW,
    )
    .await
    .unwrap();
    assert_eq!(dois.skips.get("obra-cap"), Some(&1));
}

/// Recusa do serviço devolve o HOLD na hora (`held.release` do
/// `autofetch-runner.ts:156` na recusa e `165` no erro; a tabela `budget` pede o
/// mesmo par, `autofetch-gates.ts:95`). O lease já é provado por
/// `lease_volta_quando_o_enqueue_falha`; aqui o alvo é só o hold, que sem isso
/// ficaria preso até o `release_all` do fim do lote.
#[test]
fn recusa_do_servico_devolve_o_hold() {
    let holds = Holds::default();
    let hash = hash_of(9);
    assert!(holds.acquire(ACCOUNT, &hash));

    refuse(&holds, ACCOUNT, &hash, &Gate::Skipped);
    assert_eq!(holds.len(), 0, "hold volta na recusa");
}

/// Identidade: o pack de temporada normaliza o EPISÓDIO — E01 e E02 do mesmo
/// pack dividem a vaga (`autofetch-runner.ts:67`). Com o preenchimento
/// desligado os episódios voltam a ser obras distintas.
#[test]
fn pack_de_temporada_divide_a_vaga_do_episodio() {
    let pack = |episode: i64| -> Map<String, Value> {
        serde_json::from_value(json!({
            "searchKey": format!("k{episode}"),
            "imdbId": IMDB,
            "season": 1,
            "episode": episode,
            "items": [{
                "infoHash": hash_of(episode as u32),
                "title": "Titulo de Teste S01 COMPLETE 1080p",
                "_br": true,
                "_dubbed": true
            }]
        }))
        .unwrap()
    };
    let um = pack(1);
    let dois = pack(2);
    let itens_um = parse_items(&um);
    let itens_dois = parse_items(&dois);

    let ligado = (
        identity(ADAPTER, ACCOUNT, &um, &itens_um[0], true),
        identity(ADAPTER, ACCOUNT, &dois, &itens_dois[0], true),
    );
    assert!(ligado.0.is_pack && ligado.1.is_pack);
    assert_eq!(ligado.0.episode, None, "pack não carrega episódio");
    assert_eq!(
        obra_identity(&ligado.0),
        obra_identity(&ligado.1),
        "pack de S01 divide a vaga entre episódios"
    );

    let desligado = (
        identity(ADAPTER, ACCOUNT, &um, &itens_um[0], false),
        identity(ADAPTER, ACCOUNT, &dois, &itens_dois[0], false),
    );
    assert!(!desligado.0.is_pack && !desligado.1.is_pack);
    assert_ne!(
        obra_identity(&desligado.0),
        obra_identity(&desligado.1),
        "sem season fill, episódio é obra distinta"
    );
}
