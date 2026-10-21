use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use adom_core::{BankRow, InstantMagnet, InstantSource, InstantWork, WorkTarget};
use adom_debrid::account::{AccountInventory, InventoryItem};

use crate::cache::MemorySwrStore;
use crate::internal_types::ReleaseEntry;
use crate::orchestrator::account::{AccountInventorySource, AccountRequest};
use crate::orchestrator::index_source::{
    BankFilterCtx, IndexedReleaseWire, MagnetBankSource, ReleaseIndexSource,
};
use crate::orchestrator::live_state::LiveBatchState;
use crate::orchestrator::{Orchestrator, OrchestratorConfig};

use super::follow_up_count;
use crate::orchestrator::finish::SearchInput;
use crate::orchestrator::index_effects::FollowUpKind;
use crate::orchestrator::SearchMeta;

struct FakeIndex {
    releases: Vec<IndexedReleaseWire>,
    partial: bool,
    records: Mutex<Vec<ReleaseEntry>>,
}

impl FakeIndex {
    fn new(releases: Vec<IndexedReleaseWire>, partial: bool) -> Self {
        FakeIndex {
            releases,
            partial,
            records: Mutex::new(Vec::new()),
        }
    }
}

impl ReleaseIndexSource for FakeIndex {
    fn lookup(
        &self,
        _imdb: &str,
        _season: Option<i64>,
        _episode: Option<i64>,
        _now_ms: i64,
    ) -> Vec<IndexedReleaseWire> {
        self.releases.clone()
    }

    fn is_partial(
        &self,
        _imdb: &str,
        _season: Option<i64>,
        _episode: Option<i64>,
        _now_ms: i64,
    ) -> bool {
        self.partial
    }

    fn record(
        &self,
        entry: &ReleaseEntry,
        _now_ms: i64,
        _bank: Option<&dyn Fn(&[String]) -> Vec<BankRow>>,
    ) -> Result<usize, String> {
        self.records.lock().unwrap().push(entry.clone());
        Ok(entry.items.len())
    }
}

struct FakeBank {
    works: Vec<InstantWork>,
    sources: BTreeMap<String, Vec<InstantSource>>,
    br_row: bool,
    marks: Mutex<Vec<(Vec<Value>, Vec<Value>)>>,
}

impl FakeBank {
    fn new(works: Vec<InstantWork>, sources: BTreeMap<String, Vec<InstantSource>>) -> Self {
        FakeBank {
            works,
            sources,
            br_row: false,
            marks: Mutex::new(Vec::new()),
        }
    }
}

impl MagnetBankSource for FakeBank {
    fn works_for_obra_many(
        &self,
        _imdb: &str,
        _targets: &[WorkTarget],
        _limit_per_target: usize,
        _max_total: usize,
        _indexers: Option<&[String]>,
    ) -> Vec<InstantWork> {
        self.works.clone()
    }

    fn sources_for_many(&self, _hashes: &[String]) -> BTreeMap<String, Vec<InstantSource>> {
        self.sources.clone()
    }

    fn bank_rows_many(&self, hashes: &[String]) -> Vec<BankRow> {
        hashes
            .iter()
            .map(|hash| BankRow {
                hash: hash.clone(),
                uri: String::new(),
                title: String::new(),
            })
            .collect()
    }

    fn mark_filter_outcome(
        &self,
        entered: &[Value],
        survivors: &[Value],
        _ctx: &BankFilterCtx,
        _now_ms: i64,
    ) -> bool {
        self.marks
            .lock()
            .unwrap()
            .push((entered.to_vec(), survivors.to_vec()));
        true
    }

    fn has_br_row(&self, _imdb: &str, _targets: &[WorkTarget]) -> bool {
        self.br_row
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(1_000_000)
}

fn release(
    hash: &str,
    is_br: bool,
    dubbed: bool,
    quality: &str,
    indexer: &str,
) -> IndexedReleaseWire {
    IndexedReleaseWire {
        hash: hash.to_string(),
        title: format!("Filme 2024 1080p {hash}"),
        size: Some(100),
        indexer: indexer.to_string(),
        tracker: None,
        is_br,
        dubbed,
        quality: quality.to_string(),
        seeders: 10,
        seen_at: now_ms(),
        lied: false,
        source: None,
        media_source: None,
    }
}

fn instant_work(hash: &str, title: &str, passed: i64) -> InstantWork {
    InstantWork {
        hash: hash.to_string(),
        passed_filter: passed,
        last_seen: now_ms() - 1_000,
        first_seen: now_ms() - 10_000,
        magnet: Some(InstantMagnet {
            hash: hash.to_string(),
            uri: format!("magnet:?xt=urn:btih:{hash}&dn={title}"),
            title: title.to_string(),
            size: 1_000,
            is_br: true,
            dubbed: true,
            quality: "1080p".to_string(),
            seeders_max: 5,
            seeders_last: 5,
            last_seen: now_ms() - 1_000,
            lied: false,
        }),
    }
}

fn sources(hash: &str) -> BTreeMap<String, Vec<InstantSource>> {
    let mut map = BTreeMap::new();
    map.insert(
        hash.to_string(),
        vec![InstantSource {
            indexer: "bludv".to_string(),
            tracker: "BluDV".to_string(),
            last_seen: now_ms() - 1_000,
            allowed: false, // o orquestrador recalcula
        }],
    );
    map
}

fn input(kind: &str, options: Value) -> SearchInput {
    SearchInput {
        kind: kind.to_string(),
        id: "tt1234567".to_string(),
        encoded: Some("e30".to_string()),
        prefix: "http://localhost".to_string(),
        options,
        key: "streams:v21:movie:tt1234567".to_string(),
        now_ms: now_ms(),
        deadline_at: None,
    }
}

fn meta(season: Option<i64>, episode: Option<i64>) -> SearchMeta {
    SearchMeta {
        imdb_id: "tt1234567".to_string(),
        season,
        episode,
        name: "Filme".to_string(),
        names: vec!["Filme".to_string()],
        year: json!("2024"),
        ..SearchMeta::default()
    }
}

fn config() -> OrchestratorConfig {
    OrchestratorConfig::default()
}

fn orch(cfg: OrchestratorConfig, index: Option<FakeIndex>, bank: Option<FakeBank>) -> Orchestrator {
    let mut orch = Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()));
    if let Some(index) = index {
        orch = orch.with_index_source(Arc::new(index));
    }
    if let Some(bank) = bank {
        orch = orch.with_bank_source(Arc::new(bank));
    }
    orch
}

#[tokio::test]
async fn indice_coberto_responde_com_a_marca_da_foto() {
    let indexed = vec![release(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        true,
        true,
        "1080p",
        "bludv",
    )];
    let orch = orch(config(), Some(FakeIndex::new(indexed, false)), None);
    let scan = orch
        .native_index_scan(
            &input("movie", json!({"providers": ["jackett"]})),
            &meta(None, None),
        )
        .await;
    assert!(!scan.is_partial);
    assert!(scan.index_covered);
    assert_eq!(scan.index_items.len(), 1);
    assert!(scan.index_items[0].from_snapshot, "foto do índice");
    assert!(scan.index_items[0].is_br);
    // Coberto com BR dublado comprovado: nenhum follow-up.
    assert!(scan.follow_up.actions.is_empty());
}

#[tokio::test]
async fn fast_path_do_indice_limpa_o_selo_da_foto() {
    let indexed = vec![release(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        true,
        true,
        "1080p",
        "bludv",
    )];
    let orch = orch(config(), Some(FakeIndex::new(indexed, false)), None);
    let fast = orch
        .native_fast_path(
            &input("movie", json!({"providers": ["jackett"]})),
            &meta(None, None),
        )
        .await
        .expect("índice cobre");
    assert!(!fast.instant);
    assert_eq!(fast.items.len(), 1);
    assert!(!fast.items[0].from_snapshot, "via do índice não leva 📦");
}

#[tokio::test]
async fn instantanea_do_banco_leva_selo_e_fallback_fetchable() {
    let bank = FakeBank::new(
        vec![instant_work(
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "Filme 2024 1080p Dublado",
            1,
        )],
        sources("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    );
    let orch = orch(
        config(),
        Some(FakeIndex::new(Vec::new(), false)),
        Some(bank),
    );
    let scan = orch
        .native_index_scan(
            &input(
                "movie",
                json!({"providers": ["jackett"], "preferDubbed": true}),
            ),
            &meta(None, None),
        )
        .await;
    assert!(scan.instant_eligible, "acervo cobre o pool");
    assert_eq!(scan.instant_items.len(), 1);
    assert!(scan.instant_items[0].from_fallback, "selo 📦");
    assert_eq!(
        scan.instant_items[0]
            .extra
            .get("fallbackFetchable")
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert!(
        scan.follow_up.miss,
        "índice vazio continua enfileirando miss"
    );
    assert_eq!(
        follow_up_count(&scan.follow_up, FollowUpKind::HarvesterMiss),
        1
    );
}

#[tokio::test]
async fn instantanea_com_foto_velha_nao_responde() {
    let mut work = instant_work(
        "cccccccccccccccccccccccccccccccccccccccc",
        "Filme 2024 1080p Dublado",
        1,
    );
    work.last_seen = now_ms() - 30 * 86_400_000;
    if let Some(magnet) = work.magnet.as_mut() {
        magnet.last_seen = work.last_seen;
    }
    let bank = FakeBank::new(
        vec![work],
        sources("cccccccccccccccccccccccccccccccccccccccc"),
    );
    let orch = orch(
        config(),
        Some(FakeIndex::new(Vec::new(), false)),
        Some(bank),
    );
    let scan = orch
        .native_index_scan(
            &input("movie", json!({"providers": ["jackett"]})),
            &meta(None, None),
        )
        .await;
    assert!(!scan.instant_eligible);
}

#[tokio::test]
async fn instantanea_sem_cobertura_nao_responde() {
    let mut work = instant_work(
        "dddddddddddddddddddddddddddddddddddddddd",
        "Filme 2024 1080p Legendado",
        1,
    );
    if let Some(magnet) = work.magnet.as_mut() {
        magnet.is_br = false;
        magnet.dubbed = false;
        magnet.quality = "480p".to_string();
        magnet.seeders_last = 0;
    }
    let bank = FakeBank::new(
        vec![work],
        sources("dddddddddddddddddddddddddddddddddddddddd"),
    );
    let orch = orch(
        config(),
        Some(FakeIndex::new(Vec::new(), false)),
        Some(bank),
    );
    let scan = orch
        .native_index_scan(
            &input("movie", json!({"providers": ["jackett"]})),
            &meta(None, None),
        )
        .await;
    assert!(!scan.instant_eligible, "sem dublado e sem swarm saudável");
}

#[tokio::test]
async fn filtro_de_origem_corta_release_de_outro_provider() {
    let indexed = vec![release(
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        true,
        true,
        "1080p",
        "torrentio",
    )];
    let orch = orch(config(), Some(FakeIndex::new(indexed, false)), None);
    let scan = orch
        .native_index_scan(
            &input(
                "movie",
                json!({"providers": ["jackett"], "jackettIndexers": ["bludv"]}),
            ),
            &meta(None, None),
        )
        .await;
    assert!(scan.indexed.is_empty(), "torrentio fora do p:jackett");
    assert!(scan.follow_up.miss);
}

#[tokio::test]
async fn parcial_bloqueia_o_fast_path_do_indice() {
    let indexed = vec![release(
        "ffffffffffffffffffffffffffffffffffffffff",
        true,
        true,
        "1080p",
        "bludv",
    )];
    let orch = orch(config(), Some(FakeIndex::new(indexed, true)), None);
    let scan = orch
        .native_index_scan(
            &input("movie", json!({"providers": ["jackett"]})),
            &meta(None, None),
        )
        .await;
    assert!(scan.is_partial);
    assert!(!scan.index_covered);
    assert!(scan.follow_up.partial);
}

#[tokio::test]
async fn serie_busca_episodio_temporada_e_raiz() {
    let mut work = instant_work(
        "0101010101010101010101010101010101010101",
        "Serie 2024 S02E05 1080p Dublado",
        1,
    );
    // Release global dublada (isBr=false): o filtro global aceita sem ano; o
    // que está sob teste aqui é o alvo de SÉRIE (episódio/pack/raiz) e a
    // cobertura por episódio NOMEADO.
    if let Some(magnet) = work.magnet.as_mut() {
        magnet.is_br = false;
    }
    let bank = FakeBank::new(
        vec![work],
        sources("0101010101010101010101010101010101010101"),
    );
    let orch = orch(
        config(),
        Some(FakeIndex::new(Vec::new(), false)),
        Some(bank),
    );
    let mut series_meta = meta(Some(2), Some(5));
    series_meta.name = "Serie".to_string();
    series_meta.names = vec!["Serie".to_string()];
    let scan = orch
        .native_index_scan(
            &input("series", json!({"providers": ["jackett"]})),
            &series_meta,
        )
        .await;
    assert!(scan.instant_eligible, "episódio nomeado cobre");
}

#[test]
fn banco_marks_sao_gravados_na_escrita_do_indice() {
    // A escrita nativa é exercida no `late`; aqui garantimos que o contrato da
    // trait de banco é chamável com o lote do índice.
    let bank = FakeBank::new(Vec::new(), BTreeMap::new());
    let entered = vec![json!({"infoHash": "aa"})];
    let survivors = vec![json!({"infoHash": "aa"})];
    assert!(bank.mark_filter_outcome(
        &entered,
        &survivors,
        &BankFilterCtx {
            imdb_id: "tt1".to_string(),
            season: None,
            episode: None,
        },
        now_ms()
    ));
    assert_eq!(bank.marks.lock().unwrap().len(), 1);
}

#[test]
fn hashes_do_indice_e_do_banco_nao_se_misturam() {
    // O hash vindo do item cru é o mesmo formato que o `bank_hash` usa no
    // `liveHashes`.
    let a = crate::raw_item::raw_item_from_value(
        &json!({"infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}),
    );
    assert_eq!(a.bank_hash(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
}

/// Inventário fake para o caminho `account_items` do índice nativo.
struct FakeAccount;

impl AccountInventorySource for FakeAccount {
    fn inventory<'a>(
        &'a self,
        _req: AccountRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<AccountInventory, String>> + Send + 'a>,
    > {
        Box::pin(async {
            Ok(AccountInventory {
                known: true,
                unusable: None,
                items: vec![InventoryItem {
                    title: "Filme 2024 1080p Dublado".to_string(),
                    info_hash: "a".repeat(40),
                    size: 1_000.0,
                    id: None,
                }],
            })
        })
    }
}

#[tokio::test]
async fn conta_entra_no_caminho_do_indice_quando_ha_fonte_nativa() {
    let mut cfg = config();
    cfg.account_fast_path = true;
    cfg.account_inventory_source = true;
    let orch = Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()))
        .with_index_source(Arc::new(FakeIndex::new(Vec::new(), false)))
        .with_account_source(Arc::new(FakeAccount));
    let scan = orch
        .native_index_scan(
            &input(
                "movie",
                json!({"providers": ["jackett"], "debridService": "torbox", "debridApiKey": "k"}),
            ),
            &meta(None, None),
        )
        .await;
    assert_eq!(scan.account_items.len(), 1);
    assert!(scan.account_items[0].from_account);
}

#[tokio::test]
async fn reserva_do_banco_nativo_reinjeta_item_de_indexer_falho() {
    let hash = "b".repeat(40);
    let bank = FakeBank::new(
        vec![InstantWork {
            hash: hash.clone(),
            passed_filter: 1,
            last_seen: now_ms(),
            first_seen: now_ms() - 10,
            magnet: Some(InstantMagnet {
                hash: hash.clone(),
                uri: format!("magnet:?xt=urn:btih:{hash}&dn=Filme.2024.1080p.Dublado"),
                title: "Filme 2024 1080p Dublado".to_string(),
                size: 1_000,
                is_br: true,
                dubbed: true,
                quality: "1080p".to_string(),
                seeders_max: 1,
                seeders_last: 1,
                last_seen: now_ms(),
                lied: false,
            }),
        }],
        sources(&hash),
    );
    let orch = orch(config(), None, Some(bank));
    let mut live = LiveBatchState::default();
    live.failed.insert("bludv".to_string());
    let items = orch
        .with_fallback(
            &input("movie", json!({"providers": ["jackett"]})),
            &meta(None, None),
            Vec::new(),
            Some(&live),
        )
        .await;
    assert_eq!(items.len(), 1);
    assert!(items[0].from_fallback);
    assert_eq!(
        items[0]
            .extra
            .get("fallbackFetchable")
            .and_then(|v| v.as_bool()),
        Some(true)
    );
}
