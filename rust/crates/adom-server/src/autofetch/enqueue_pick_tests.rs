//! Testes do CONSUMO das réguas do painel na seleção do lote (P4) e do `obra`
//! do marker do aceite (divergência 6).
//!
//! Os casos vão pelo escritor de verdade (`enqueue::run`) de propósito: o que se
//! prova aqui não é o `pick` isolado, e sim que `LivePolicy` chega ao pool
//! `seeds` (via [`super::pick`] → `pick_seeds_pool`) e que o marker gravado casa
//! com o registro por obra — o mesmo casamento que o `evict_job` faz.
//!
//! Todo caso PINA o boletim `cfg:v1:autofetch` com TODAS as réguas: o overlay
//! vence o `.env` nos dois lados, então nenhum teste daqui depende do ambiente
//! do processo (os testes de `gates` escrevem nele em paralelo).

use adom_autofetch::v3::{ObraStoreV3, QueueV3};
use adom_core::{marker_obra, obra_digest, obra_identity, obra_key, obra_prefix, MarkerValue};
use adom_index::NativeKv;
use serde_json::{json, Map, Value};

use crate::autofetch::enqueue::{obra, run, Holds};
use crate::autofetch::enqueue_items::parse_items;
use crate::autofetch::fakes::{batch_payload, job, FakeDebrid, SCOPE};
use crate::autofetch::Policy;

const SEARCH: &str = "tt1234567:1:2";
const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta-de-teste";
const IMDB: &str = "tt1234567";
/// Instante fixo: janela, TTL do KV e orçamento ficam determinísticos.
const NOW: i64 = 1_800_000_000_000;

fn kv() -> NativeKv {
    NativeKv::open_memory().unwrap()
}

fn hash_of(n: u32) -> String {
    format!("{n:040x}")
}

/// Boletim do painel com o par default/clamp do TS PINADO e o `extra` por cima.
fn overlay(kv: &NativeKv, extra: Value) {
    let mut base = json!({
        "autoFetchBr": true,
        "autoFetchMax": 3,
        "autoFetchTopSeeds": true,
        "autoFetchTopSeedsMax": 1,
        "autoFetchSeedsPtFirst": false,
        "autoFetchMinSeeders": 3,
        "autoFetchRareThreshold": 0,
        "autoFetchRareMaxSeeders": 10,
        "autoFetchRareMax": 4,
        "autoFetchQueue": false,
        "autoFetchPauseAt": 0,
        "autoFetchSeasonFill": true,
        "autoFetchTtl": 21_600
    });
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    kv.put_json("cfg:v1:autofetch", &base, 86_400, NOW).unwrap();
}

/// Stream do pool `seeds` (`_br`/`_dubbed` falsos) com título e swarm dados.
fn item(hash: &str, title: &str, seeders: i64) -> Value {
    json!({
        "infoHash": hash,
        "title": title,
        "name": format!("{title} 👤 {seeders}"),
        "_quality": "1080p",
        "_seeders": seeders,
        "_br": false,
        "_dubbed": false
    })
}

/// Lote de FILME (sem temporada: nada de bônus de pack na ordenação do pool).
fn payload(items: Vec<Value>) -> Map<String, Value> {
    serde_json::from_value(json!({
        "searchKey": SEARCH,
        "imdbId": IMDB,
        "items": items
    }))
    .unwrap()
}

/// Roda um lote com o overlay dado e devolve `(attempts, hashes aceitos)`.
async fn lote(extra: Value, items: &[Value]) -> (usize, Vec<String>) {
    let kv = kv();
    overlay(&kv, extra);
    let debrid = FakeDebrid::accepting();
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &debrid,
        &job(SCOPE, payload(items.to_vec())),
        NOW,
    )
    .await
    .unwrap();
    (report.attempts, debrid.accepted())
}

/// P4 · `autoFetchBr` (`src/config/debrid.ts:195`, default LIGADO): desligado, o
/// Node devolve `[]` em `autoFetchCandidates` ANTES de escolher pool
/// (`autofetch-candidates.ts:104`) — nem hold, nem marker, nem fila.
#[tokio::test]
async fn auto_fetch_br_desligado_recusa_o_lote_sem_escrever() {
    let kv = kv();
    overlay(&kv, json!({ "autoFetchBr": false }));
    let holds = Holds::default();
    let debrid = FakeDebrid::accepting();
    let report = run(
        &kv,
        Policy::fixture(),
        &holds,
        false,
        &debrid,
        &job(SCOPE, payload(vec![item(&hash_of(1), "Movie 1080p", 40)])),
        NOW,
    )
    .await
    .unwrap();

    assert_eq!(report.refused, Some("disabled"));
    assert!(debrid.accepted().is_empty(), "nem chega ao serviço");
    assert_eq!(holds.len(), 0, "o gate mestra fica ANTES do hold");
    assert!(
        kv.keys_matching("autofetch", NOW).unwrap().is_empty(),
        "lote desligado não escreve nada"
    );
}

/// P4 · `autoFetchMinSeeders` (`debrid-autofetch-seeds.ts:19`, default `3`,
/// `Math.max(0, trunc(n))`): o piso entra em `SeedsPickLive.min_seeders`.
///
/// O caso mede onde o piso é a ÚNICA diferença: candidato com `0` semeador. Com
/// o default `3` o universo do pick (que conta viáveis com `minSeeders=1`) é
/// vazio; com piso `0` o `>= 0` do `topSeededPool` o admite.
#[tokio::test]
async fn auto_fetch_min_seeders_decide_quem_entra_no_pool_seeds() {
    let hash = hash_of(1);
    let items = vec![item(&hash, "Movie 1080p", 0)];

    let (attempts, accepted) = lote(json!({}), &items).await;
    assert_eq!(attempts, 0, "(a) default 3 barra quem não tem swarm");
    assert!(accepted.is_empty());

    let (attempts, accepted) = lote(json!({ "autoFetchMinSeeders": 0 }), &items).await;
    assert_eq!(attempts, 1, "(b) piso 0 abre o universo do pool");
    assert_eq!(accepted, vec![hash]);
}

/// P4 · `autoFetchSeedsPtFirst` (`debrid-autofetch-seeds.ts:34`, default
/// LIGADO): no pool `seeds` o candidato com sinal de português passa na frente
/// do mais semeado (`topSeededPool`, `autofetch-pools.ts`).
#[tokio::test]
async fn auto_fetch_seeds_pt_first_manda_o_pt_na_frente_do_swarm() {
    let pt = hash_of(1);
    let strong = hash_of(2);
    let items = vec![
        item(&strong, "Movie 1080p", 40),
        item(&pt, "Filme Dublado 1080p", 5),
    ];

    let (attempts, accepted) = lote(json!({ "autoFetchSeedsPtFirst": true }), &items).await;
    assert_eq!(attempts, 1, "(a) uma vaga só (`topSeedsMax`)");
    assert_eq!(
        accepted,
        vec![pt.clone()],
        "(b) o PT com 5 seeders ocupa a vaga do forte"
    );

    let (attempts, accepted) = lote(json!({ "autoFetchSeedsPtFirst": false }), &items).await;
    assert_eq!(attempts, 1);
    assert_eq!(
        accepted,
        vec![strong],
        "(b) desligado volta a ordem do swarm"
    );
}

/// P4 · `autoFetchRareThreshold` (`debrid-autofetch-seeds.ts:28`, default `6`,
/// clamp `0..20`) e `autoFetchRareMaxSeeders` (linha 29, default `10`, piso
/// `1`): o regime RARO sobe o limite imediato de `topSeedsMax` para `rareMax`
/// (`autofetch-seeds-pool.ts:101-121`), e é o único caminho que busca o
/// candidato fraco.
#[tokio::test]
async fn auto_fetch_rare_threshold_e_max_seeders_ligam_o_regime_raro() {
    // 3 e 2 seeders: poucos viáveis e fracos (melhor `3 < 10`).
    let items = vec![
        item(&hash_of(1), "Movie A 1080p", 3),
        item(&hash_of(2), "Movie B 1080p", 2),
    ];

    let (attempts, _) = lote(
        json!({ "autoFetchRareThreshold": 6, "autoFetchRareMaxSeeders": 10 }),
        &items,
    )
    .await;
    assert_eq!(attempts, 2, "(a) raro ativo: vaga imediata vira `rareMax`");

    let (attempts, _) = lote(json!({ "autoFetchRareThreshold": 0 }), &items).await;
    assert_eq!(attempts, 1, "(b) limiar 0 desliga o regime raro");

    let (attempts, _) = lote(json!({ "autoFetchRareMaxSeeders": 2 }), &items).await;
    assert_eq!(attempts, 1, "(b) teto 2: `3 < 2` é falso, sem regime raro");

    let (attempts, _) = lote(json!({ "autoFetchRareMaxSeeders": -4 }), &items).await;
    assert_eq!(attempts, 1, "(c) negativo cai no piso 1 do clamp");
}

/// Divergência 6 · o marker do ACEITE carrega `obra` = digest da identidade da
/// obra (`autofetch-runner.ts:109-113`), o MESMO que virou chave do registro.
///
/// Prova o casamento que a evicção faz (`evict_job::marker_digest` +
/// `marker_matches_work`): `marker_obra(marker) == digest` e o registro em
/// `autofetch:v3:o:<digest>` contém o hash ready — sem isso o passo degrada
/// para `evict-no-marker`/`evict-no-record`.
#[tokio::test]
async fn marker_do_aceite_casa_com_a_obra_do_registro() {
    let kv = kv();
    overlay(
        &kv,
        json!({ "autoFetchQueue": true, "autoFetchQueueDepth": 6 }),
    );
    let hash = hash_of(1);
    let batch = batch_payload(SEARCH, &[(&hash, true)]);
    let debrid = FakeDebrid::accepting();
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &debrid,
        &job(SCOPE, batch.clone()),
        NOW,
    )
    .await
    .unwrap();
    assert_eq!(report.enqueued.len(), 1, "aceite antes de qualquer prova");

    let raw = QueueV3::new(&kv)
        .marker(ADAPTER, ACCOUNT, &hash, NOW)
        .unwrap()
        .expect("marker do aceite");
    let value = MarkerValue::from_json(&raw);
    let digest = marker_obra(&value).expect("marker do aceite carrega `obra`");

    // Formato completo de `evictMarkerMeta` + `markerValue`.
    assert_eq!(raw["id"], json!(format!("id-{hash}")));
    assert_eq!(raw["pool"], json!("br"));
    assert_eq!(raw["title"], json!("Titulo de Teste"), "primeira linha só");
    assert_eq!(raw["acceptedAt"], json!(NOW));
    assert_eq!(raw["br"], json!(true));
    assert_eq!(raw["dubbed"], json!(true));

    // O digest é o da identidade da obra — a MESMA régua do `enqueue_obra`.
    let items = parse_items(&batch);
    let ident = obra::identity(ADAPTER, ACCOUNT, &batch, &items[0], true);
    assert_eq!(digest, obra_digest(&obra_identity(&ident)));
    assert_eq!(
        format!("{}{digest}", obra_prefix()),
        obra_key(&obra_identity(&ident))
    );

    // Casamento do `evict_job`: o registro da obra contém o hash ready.
    let record = ObraStoreV3::new(&kv)
        .read(&format!("{}{digest}", obra_prefix()), NOW)
        .unwrap();
    assert!(
        record
            .iter()
            .any(|entry| entry.hash == hash && entry.pool == "br"),
        "o registro sob o digest do marker guarda o hash aceito"
    );
}
