use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use adom_core::WorkTarget;
use adom_harvest::{
    br_evidence_rank, prioritize, BrEvidence, HarvestEntry, HarvestMediaType, HarvestQueue,
    HarvestQueueConfig, HarvestRequest, PrioritizeConfig,
};
use adom_search::orchestrator::{BankLookup, IndexedReleaseWire, ReleaseIndexSource};
use adom_search::ReleaseEntry;
use adom_store::{RecordOptions, ReleaseIndexStore};
use serde_json::{json, Value};

use super::{queue_identities, EvidenceSnapshot, WorkIdentity};

const NOW: i64 = 1_700_000_000_000;

fn movie(imdb: &str, reason: &str, at: i64) -> HarvestEntry {
    HarvestEntry {
        imdb_id: imdb.into(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: reason.into(),
        enqueued_at: at,
        priority_at: (reason == "br-gap").then_some(at),
        resumed: false,
        br_probe: false,
        full_base: false,
        full_intent: None,
    }
}

fn series(imdb: &str, season: i32, episode: i32) -> HarvestEntry {
    let mut entry = movie(imdb, "miss", NOW);
    entry.media_type = HarvestMediaType::Series;
    entry.season = Some(season);
    entry.episode = Some(episode);
    entry
}

fn wid(imdb: &str, season: Option<i32>, episode: Option<i32>) -> WorkIdentity {
    WorkIdentity {
        imdb_id: imdb.into(),
        season,
        episode,
    }
}

fn hash(n: u8) -> String {
    format!("{n:02x}").repeat(20)
}

fn item(title: &str, hash: &str, is_br: bool, lied: bool, autofetch: bool) -> Value {
    let mut obj = json!({
        "title": title, "infoHash": hash, "isBr": is_br, "lied": lied,
        "seeders": 5, "indexer": "bludv",
    });
    if autofetch {
        obj["indexSource"] = json!("autofetch");
        obj["dubbed"] = json!(true);
        obj["quality"] = json!("1080p");
    }
    obj
}

fn record(store: &ReleaseIndexStore, imdb: &str, loc: WorkTarget, items: &[Value]) {
    store
        .record(
            imdb,
            loc,
            items,
            RecordOptions::default(),
            30 * 24 * 3600,
            60,
            NOW,
            None,
        )
        .expect("record");
}

fn to_wire(release: adom_store::IndexedRelease) -> IndexedReleaseWire {
    IndexedReleaseWire {
        hash: release.hash,
        title: release.title,
        size: release.size,
        indexer: release.indexer,
        tracker: release.tracker,
        is_br: release.is_br,
        dubbed: release.dubbed,
        quality: release.quality,
        seeders: release.seeders,
        seen_at: release.seen_at,
        lied: release.lied,
        source: release.source,
        media_source: release.media_source,
    }
}

struct StoreIndex {
    store: ReleaseIndexStore,
    lookups: AtomicUsize,
}

impl StoreIndex {
    fn memory() -> Self {
        Self {
            store: ReleaseIndexStore::open_memory().expect("sqlite"),
            lookups: AtomicUsize::new(0),
        }
    }
}

impl ReleaseIndexSource for StoreIndex {
    fn lookup(
        &self,
        imdb: &str,
        season: Option<i64>,
        episode: Option<i64>,
        now: i64,
    ) -> Vec<IndexedReleaseWire> {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        self.store
            .lookup(imdb, WorkTarget { season, episode }, now)
            .into_iter()
            .map(to_wire)
            .collect()
    }
    fn is_partial(&self, _: &str, _: Option<i64>, _: Option<i64>, _: i64) -> bool {
        false
    }
    fn record(&self, _: &ReleaseEntry, _: i64, _: Option<BankLookup<'_>>) -> Result<usize, String> {
        Ok(0)
    }
}

fn rank_of(imdb: &str, snap: &EvidenceSnapshot) -> u8 {
    br_evidence_rank(&movie(imdb, "miss", NOW), snap)
}

fn root() -> WorkTarget {
    WorkTarget {
        season: None,
        episode: None,
    }
}

#[test]
fn br_dublada_eleva_lied_presenca_global_autofetch_nao() {
    let index = StoreIndex::memory();
    let cases = [
        ("tt8100001", "Filme 1994 1080p Dublado", true, false, false),
        ("tt8100002", "Filme 1994 1080p Dublado", true, true, false),
        ("tt8100003", "Filme 1994 1080p BluRay", true, false, false),
        ("tt8100004", "Movie 1994 1080p BluRay", false, false, false),
        ("tt8100005", "Filme 1994 1080p Dublado", true, false, true),
    ];
    for (i, (imdb, title, is_br, lied, auto)) in cases.iter().enumerate() {
        record(
            &index.store,
            imdb,
            root(),
            &[item(title, &hash(i as u8 + 1), *is_br, *lied, *auto)],
        );
    }
    let ids: Vec<_> = cases
        .iter()
        .map(|(imdb, ..)| wid(imdb, None, None))
        .collect();
    let shared = Arc::new(index);
    let snap = EvidenceSnapshot::from_index(Some(shared.as_ref()), &ids, NOW);

    assert!(snap.has_br_dubbed("tt8100001", None, None));
    assert_eq!(rank_of("tt8100001", &snap), 2);
    for imdb in ["tt8100002", "tt8100003", "tt8100004", "tt8100005"] {
        assert!(snap.lookup(imdb, None, None), "{imdb} presente");
        assert!(!snap.has_br_dubbed(imdb, None, None), "{imdb} não eleva");
        assert_eq!(rank_of(imdb, &snap), 0);
    }
    assert_eq!(shared.lookups.load(Ordering::SeqCst), 5);
}

#[test]
fn s1e1_e_s1e2_nao_compartilham_evidencia() {
    let index = StoreIndex::memory();
    record(
        &index.store,
        "tt0903747",
        WorkTarget {
            season: Some(1),
            episode: Some(1),
        },
        &[item(
            "Serie S01E01 1080p Dublado",
            &hash(11),
            true,
            false,
            false,
        )],
    );
    record(
        &index.store,
        "tt0903747",
        WorkTarget {
            season: Some(1),
            episode: Some(2),
        },
        &[item(
            "Serie S01E02 1080p BluRay",
            &hash(12),
            true,
            false,
            false,
        )],
    );
    let ids = vec![
        wid("tt0903747", Some(1), Some(1)),
        wid("tt0903747", Some(1), Some(2)),
    ];
    let shared = Arc::new(index);
    let snap = EvidenceSnapshot::from_index(Some(shared.as_ref()), &ids, NOW);
    assert!(snap.has_br_dubbed("tt0903747", Some(1), Some(1)));
    assert!(!snap.has_br_dubbed("tt0903747", Some(1), Some(2)));
    assert_eq!(br_evidence_rank(&series("tt0903747", 1, 1), &snap), 2);
    assert_eq!(br_evidence_rank(&series("tt0903747", 1, 2), &snap), 0);
    assert_eq!(shared.lookups.load(Ordering::SeqCst), 2);
}

#[test]
fn indice_ausente_e_identidade_nova_sao_neutros() {
    let snap = EvidenceSnapshot::from_index(None, &[], NOW);
    assert!(!snap.lookup("tt0111161", None, None));
    assert!(!snap.has_br_dubbed("tt0111161", None, None));
    assert_eq!(rank_of("tt0111161", &snap), 0);
}

#[test]
fn preview_segue_a_mesma_foto_e_toggle_br_first() {
    let store = StoreIndex::memory();
    record(
        &store.store,
        "tt8200002",
        root(),
        &[item(
            "Filme 1994 1080p Dublado",
            &hash(21),
            true,
            false,
            false,
        )],
    );
    let ids = [wid("tt8200001", None, None), wid("tt8200002", None, None)];
    let shared = Arc::new(store);
    let snap = EvidenceSnapshot::from_index(Some(shared.as_ref()), &ids, NOW);
    let mut queue = HarvestQueue::new(HarvestQueueConfig::default());
    queue.replace(vec![
        movie("tt8200001", "miss", NOW - 1_000),
        movie("tt8200002", "miss", NOW),
    ]);
    queue.prioritize(&snap, NOW);
    assert_eq!(queue.preview(2)[0].imdb_id, "tt8200002");
    queue.set_config(HarvestQueueConfig {
        br_first: false,
        ..HarvestQueueConfig::default()
    });
    queue.prioritize(&snap, NOW);
    assert_eq!(queue.preview(2)[0].imdb_id, "tt8200001");
}

#[test]
fn uma_leitura_por_identidade_e_zero_no_comparador() {
    struct CountIndex {
        lookups: AtomicUsize,
        rows: HashMap<String, Vec<IndexedReleaseWire>>,
    }
    impl ReleaseIndexSource for CountIndex {
        fn lookup(
            &self,
            imdb: &str,
            season: Option<i64>,
            episode: Option<i64>,
            _: i64,
        ) -> Vec<IndexedReleaseWire> {
            self.lookups.fetch_add(1, Ordering::SeqCst);
            self.rows
                .get(&format!(
                    "{imdb}:{}:{}",
                    season.unwrap_or(-1),
                    episode.unwrap_or(-1)
                ))
                .cloned()
                .unwrap_or_default()
        }
        fn is_partial(&self, _: &str, _: Option<i64>, _: Option<i64>, _: i64) -> bool {
            false
        }
        fn record(
            &self,
            _: &ReleaseEntry,
            _: i64,
            _: Option<BankLookup<'_>>,
        ) -> Result<usize, String> {
            Ok(0)
        }
    }

    let mut rows = HashMap::new();
    let mut identities = Vec::new();
    let mut entries = Vec::new();
    for i in 0..200 {
        let imdb = format!("tt83{i:05}");
        rows.insert(
            format!("{imdb}:-1:-1"),
            vec![IndexedReleaseWire {
                hash: hash((i % 200) as u8),
                is_br: i == 0,
                dubbed: i == 0,
                quality: "1080p".into(),
                ..IndexedReleaseWire::default()
            }],
        );
        identities.push(wid(&imdb, None, None));
        entries.push(movie(&imdb, "miss", NOW - i as i64));
    }
    identities.push(identities[0].clone());
    let index = Arc::new(CountIndex {
        lookups: AtomicUsize::new(0),
        rows,
    });
    let started = Instant::now();
    let snap = EvidenceSnapshot::from_index(Some(index.as_ref()), &identities, NOW);
    let built = started.elapsed();
    assert_eq!(index.lookups.load(Ordering::SeqCst), 200);
    assert_eq!(snap.len(), 200);
    let ordered = prioritize(&entries, &PrioritizeConfig::default(), &snap, NOW);
    assert_eq!(index.lookups.load(Ordering::SeqCst), 200);
    assert_eq!(ordered[0].imdb_id, "tt8300000");
    eprintln!("[harvest] ensaio 200 identidades: {built:?} (uma leitura/id, zero no comparador)");
}

#[test]
fn identidades_da_fila_deduplicam() {
    let mut queue = HarvestQueue::new(HarvestQueueConfig::default());
    queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    queue.enqueue(HarvestRequest::movie("tt0068646", "miss"));
    let ids = queue_identities(&queue);
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0].imdb_id, "tt0111161");
}
