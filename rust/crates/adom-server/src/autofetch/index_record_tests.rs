//! Registro do aceite do Chupim no índice (`source:'autofetch'`).
//!
//! Duas provas: (1) o aceite GRAVA a release com a fonte do Chupim e os fatos
//! da cascata; (2) essa linha NÃO vira cobertura BR — `has_br_dubbed`,
//! `has_br_evidence` e `idx_pool_covered` continuam falsos para ela.

use std::sync::Arc;

use adom_autofetch::v3::{CascadeAttempt, CascadePool};
use adom_core::{
    has_br_dubbed, has_br_evidence, idx_pool_covered, BrGapRelease, PoolCoverageItem, WorkTarget,
};
use adom_index::{IndexedRelease, NativeKv, ReleaseIndexStore};
use adom_sources::now_ms;
use serde_json::{json, Map, Value};

use super::super::enqueue::{run, Holds, Report};
use super::super::enqueue_items::parse_items;
use super::super::fakes::{job, FakeDebrid, SCOPE};
use super::super::Policy;
use super::ops::Sink;
use super::{accepted, clear, keep, record, register, test_lock, Accepted, Op, Refuse};

/// Obra e hash só destes testes: o sink é do PROCESSO.
const IMDB: &str = "tt9900011";
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";

fn accepted_fixture() -> Accepted {
    Accepted {
        imdb_id: IMDB.to_string(),
        info_hash: HASH.to_string(),
        title: "Titulo de Teste DUBLADO".to_string(),
        size: Some(3_000_000_000),
        indexer: "torrentdosfilmes".to_string(),
        is_br: true,
        dubbed: true,
        lied: false,
        quality: Some("1080p".to_string()),
        seeders: Some(40),
        season: Some(1),
        episode: Some(2),
    }
}

/// Sink de teste que aplica como o `write_loop`: `Keep` → `record`,
/// `Forget` → `forget_autofetch_hash`. Erro de escrita vira `Refuse::Closed`
/// (falha real, não orçamento).
fn store_sink(store: &Arc<ReleaseIndexStore>, now: i64) -> Sink {
    let store = Arc::clone(store);
    Arc::new(move |op| match op {
        Op::Keep(aceite) => record(&store, &aceite, now).map_err(|_| Refuse::Closed),
        Op::Forget { imdb_id, hash } => store
            .forget_autofetch_hash(&imdb_id, &hash, now)
            .map_err(|_| Refuse::Closed),
    })
}

/// Sink que RECUSA sem tocar no índice (prova dos rótulos do painel).
fn refusing(reason: Refuse) -> Sink {
    Arc::new(move |_| Err(reason))
}

fn gap_release(release: &IndexedRelease) -> BrGapRelease<'_> {
    BrGapRelease {
        source: release.source.as_deref(),
        is_br: release.is_br,
        dubbed: release.dubbed,
        lied: release.lied,
        quality: release.quality.as_str(),
    }
}

/// Lote `autofetch_batch` desta obra, com `(hash, br, dubbed)` explícitos.
fn payload(items: &[(&str, bool, bool)]) -> Map<String, Value> {
    let items: Vec<Value> = items
        .iter()
        .map(|(hash, br, dubbed)| {
            json!({
                "infoHash": hash,
                "title": "Titulo de Teste DUBLADO\nlinha ignorada",
                "name": "Titulo de Teste 1080p",
                "_quality": "1080p",
                "_seeders": 40,
                "_size": 3_000_000_000i64,
                "_indexer": "torrentdosfilmes",
                "_br": br,
                "_dubbed": dubbed,
            })
        })
        .collect();
    serde_json::from_value(json!({
        "searchKey": format!("{IMDB}:1:2"),
        "imdbId": IMDB,
        "season": 1,
        "episode": 2,
        "items": items,
    }))
    .unwrap()
}

#[test]
fn aceite_grava_a_release_com_a_fonte_do_chupim() {
    let store = ReleaseIndexStore::open_memory().unwrap();
    assert_eq!(record(&store, &accepted_fixture(), now_ms()).unwrap(), 1);

    let found = store.lookup(
        IMDB,
        WorkTarget {
            season: Some(1),
            episode: Some(2),
        },
        now_ms(),
    );
    assert_eq!(found.len(), 1, "a release do Chupim entrou no índice");
    let release = &found[0];
    assert_eq!(release.source.as_deref(), Some("autofetch"));
    assert_eq!(release.hash, HASH);
    assert_eq!(release.title, "Titulo de Teste DUBLADO", "só a 1ª linha");
    assert_eq!(
        release.quality, "1080p",
        "qualidade da cascata, não do título"
    );
    assert_eq!(release.size, Some(3_000_000_000));
    assert_eq!(release.indexer, "torrentdosfilmes");
    assert_eq!(release.seeders, 40);
    assert!(release.is_br && release.dubbed && !release.lied);
}

/// O invariante que o registro NÃO pode quebrar: visibilidade não é cobertura.
#[test]
fn registro_do_chupim_nao_vira_prova_br() {
    let store = ReleaseIndexStore::open_memory().unwrap();
    record(&store, &accepted_fixture(), now_ms()).unwrap();
    let found = store.lookup(
        IMDB,
        WorkTarget {
            season: Some(1),
            episode: Some(2),
        },
        now_ms(),
    );
    let gap = [gap_release(&found[0])];

    assert!(found[0].is_br && found[0].dubbed, "a linha é BR dublada");
    assert!(
        !has_br_dubbed(&gap),
        "BR dublado NÃO é comprovado pelo Chupim"
    );
    assert!(!has_br_evidence(&gap), "nem evidência pública de BR");

    let coverage = [PoolCoverageItem {
        title: Some(found[0].title.clone()),
        quality: Some(found[0].quality.clone()),
        seeders: Some(json!(found[0].seeders)),
        is_br: found[0].is_br,
        dubbed: Some(Some(found[0].dubbed)),
        source: found[0].source.clone(),
        ..PoolCoverageItem::default()
    }];
    let covered = idx_pool_covered(&coverage, None, None, 0.0);
    assert!(!covered.covered, "índice não cobre pelo registro do Chupim");
    assert!(!covered.pack_only);
}

/// Fim a fim: o ACEITE do lote é quem grava (não o build, não o dreno).
#[tokio::test]
async fn aceite_do_lote_grava_no_indice() {
    let _serial = test_lock().await;
    let now = now_ms();
    let store = Arc::new(ReleaseIndexStore::open_memory().unwrap());
    register(store_sink(&store, now));

    let kv = NativeKv::open_memory().unwrap();
    kv.put_json("cfg:v1:autofetch", &json!({ "autoFetchMax": 3 }), 600, now)
        .unwrap();
    let debrid = FakeDebrid::accepting();
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &debrid,
        &job(SCOPE, payload(&[(HASH, true, true)])),
        now,
    )
    .await
    .unwrap();
    clear();

    assert_eq!(report.enqueued.len(), 1, "o aceite aconteceu");
    assert_eq!(report.skips.get("index-no-dub"), None);
    assert_eq!(report.skips.get("index-error"), None);
    let found = store.lookup(
        IMDB,
        WorkTarget {
            season: Some(1),
            episode: Some(2),
        },
        now,
    );
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].source.as_deref(), Some("autofetch"));
    assert_eq!(found[0].title, "Titulo de Teste DUBLADO", "1ª linha");
    assert!(!has_br_dubbed(&[gap_release(&found[0])]));
}

/// Pool `seeds` (sem prova de dublagem) não entra: é a regra F2 do TS.
#[tokio::test]
async fn pool_seeds_sem_prova_de_dub_nao_grava() {
    let _serial = test_lock().await;
    let now = now_ms();
    let store = Arc::new(ReleaseIndexStore::open_memory().unwrap());
    register(store_sink(&store, now));

    let lote = payload(&[(HASH, false, false)]);
    let items = parse_items(&lote);
    let attempt = adom_autofetch::v3::CascadeAttempt {
        info_hash: HASH.to_string(),
        pool: CascadePool::Seeds,
        quality: Some("1080p".to_string()),
        slot_limit: None,
        rare: false,
        overflow: false,
    };
    let mut report = super::super::enqueue::Report::default();
    keep(&attempt, &items[0], &lote, &mut report);
    clear();

    assert_eq!(report.skips.get("index-no-dub"), Some(&1));
    assert!(store
        .lookup(
            IMDB,
            WorkTarget {
                season: Some(1),
                episode: Some(2)
            },
            now
        )
        .is_empty());
}

/// Fatos do aceite: 1ª linha do título, qualidade da CASCATA (`quality` do
/// attempt vence `_quality`) e procedência do item. Lote sem temporada não
/// inventa obra: a chave fica a da raiz.
#[test]
fn fatos_do_aceite_vem_do_lote_e_da_cascata() {
    let lote = payload(&[(HASH, true, true)]);
    let items = parse_items(&lote);
    let attempt = adom_autofetch::v3::CascadeAttempt {
        info_hash: HASH.to_string(),
        pool: CascadePool::Br,
        quality: Some("2160p".to_string()),
        slot_limit: None,
        rare: false,
        overflow: false,
    };
    let aceite = accepted(
        &attempt,
        &items[0],
        &serde_json::from_value(json!({ "imdbId": IMDB })).unwrap(),
    )
    .expect("obra com IMDb");
    assert_eq!(aceite.title, "Titulo de Teste DUBLADO", "só a 1ª linha");
    assert_eq!(aceite.quality.as_deref(), Some("2160p"), "cascata manda");
    assert_eq!(aceite.indexer, "torrentdosfilmes");
    assert_eq!(aceite.size, Some(3_000_000_000), "`_size` do lote");
    assert_eq!(aceite.season, None, "lote sem temporada não inventa uma");
}

/// Lote sem IMDb não tem chave de obra: nada a gravar (o TS também saía com 0).
#[test]
fn lote_sem_imdb_nao_grava() {
    let lote = payload(&[(HASH, true, true)]);
    let items = parse_items(&lote);
    let attempt = adom_autofetch::v3::CascadeAttempt {
        info_hash: HASH.to_string(),
        pool: CascadePool::Br,
        quality: None,
        slot_limit: None,
        rare: false,
        overflow: false,
    };
    assert!(accepted(&attempt, &items[0], &Map::new()).is_none());
}

/// Tentativa mínima da cascata (obra BR, 1080p).
fn attempt() -> CascadeAttempt {
    CascadeAttempt {
        info_hash: HASH.to_string(),
        pool: CascadePool::Br,
        quality: Some("1080p".to_string()),
        slot_limit: None,
        rare: false,
        overflow: false,
    }
}

/// B1 (`^tt\d+$`), B2 (temporada/episódio em `1..=9999`) e B3 (título ≤ 512):
/// nenhum desses valores pode virar chave/valor no `idx:v14`.
///
/// B1 é a MESMA régua que `forget_autofetch_hash` exige
/// (`adom-index/src/release_index_prova.rs:66`): gravar num id que o
/// esquecimento recusa deixaria release imortal. B2 porque `WorkTarget` compõe a
/// CHAVE (`…:S<n>E<m>`): `S0`/`S-1`/`S10000` viram lixo que ninguém lê. B3 porque
/// o título do índice é o que a resposta mostra.
#[test]
fn accepted_so_aceita_chave_e_local_plausiveis() {
    let lote = payload(&[(HASH, true, true)]);
    let items = parse_items(&lote);

    for imdb in ["", "tt", "ttabc", "tt12a3", "nm1234567", " tt123", "tt123 "] {
        let mut lote = lote.clone();
        lote.insert("imdbId".into(), json!(imdb));
        assert!(
            accepted(&attempt(), &items[0], &lote).is_none(),
            "{imdb:?} não é chave de obra"
        );
    }

    for (season, episode, want) in [
        (json!(0), json!(-1), (None, None)),
        (json!(-3), json!(0), (None, None)),
        (json!(10_000), json!(9_999), (None, Some(9_999))),
        (json!(1), json!(2), (Some(1), Some(2))),
    ] {
        let mut lote = lote.clone();
        lote.insert("season".into(), season);
        lote.insert("episode".into(), episode);
        let aceite = accepted(&attempt(), &items[0], &lote).expect("obra com IMDb válido");
        assert_eq!(
            (aceite.season, aceite.episode),
            want,
            "temporada/episódio do lote"
        );
    }

    let mut lote = lote.clone();
    lote.insert(
        "items".into(),
        json!([{ "infoHash": HASH, "title": "A".repeat(600), "_br": true, "_dubbed": true }]),
    );
    let longos = parse_items(&lote);
    let aceite = accepted(&attempt(), &longos[0], &lote).expect("obra com IMDb válido");
    assert_eq!(aceite.title.chars().count(), 512, "título cortado em 512");
}

/// Orçamento: fila CHEIA é `index-full` (backoff, não falha) e escritor
/// fechado/erro real é `index-error`. Antes os dois caíam no mesmo rótulo e o
/// painel não distinguia orçamento de pane.
#[tokio::test]
async fn orcamento_cheio_conta_index_full_e_nao_index_error() {
    let _serial = test_lock().await;
    let lote = payload(&[(HASH, true, true)]);
    let items = parse_items(&lote);

    register(refusing(Refuse::Full));
    let mut report = Report::default();
    keep(&attempt(), &items[0], &lote, &mut report);
    clear();
    assert_eq!(
        report.skips.get("index-full"),
        Some(&1),
        "fila cheia = backoff"
    );
    assert_eq!(report.skips.get("index-error"), None);

    register(refusing(Refuse::Closed));
    let mut report = Report::default();
    keep(&attempt(), &items[0], &lote, &mut report);
    clear();
    assert_eq!(
        report.skips.get("index-error"),
        Some(&1),
        "sem escritor = pane"
    );
    assert_eq!(report.skips.get("index-full"), None);
}
