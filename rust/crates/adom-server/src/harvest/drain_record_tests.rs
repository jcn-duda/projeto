use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use adom_core::{BrTransition, RelevanceSettings};
use adom_harvest::{HarvestEntry, HarvestMediaType, HarvestStore};
use adom_search::orchestrator::{BankLookup, IndexedReleaseWire, RawItem, ReleaseIndexSource};
use adom_search::ReleaseEntry;
use adom_store::{streams_prefix, NativeReleaseIndex, ReleaseIndexStore, StreamsStore};

use super::{apply_transition, record_collected, retry_invalidations, RecordArgs};

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const NOW: i64 = 1_700_000_000_000;

fn movie(imdb: &str) -> HarvestEntry {
    HarvestEntry {
        imdb_id: imdb.into(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: "br-gap".into(),
        enqueued_at: NOW,
        priority_at: Some(NOW),
        resumed: false,
        br_probe: true,
        full_base: false,
        full_intent: None,
    }
}

fn wire(hash: &str, quality: &str, seeders: i64, dubbed: bool) -> IndexedReleaseWire {
    IndexedReleaseWire {
        hash: hash.into(),
        title: "Obra".into(),
        size: None,
        indexer: "x".into(),
        tracker: None,
        is_br: true,
        dubbed,
        quality: quality.into(),
        seeders,
        seen_at: NOW,
        lied: false,
        source: None,
        media_source: None,
    }
}

struct StubIndex {
    lookups: AtomicUsize,
    before: Vec<IndexedReleaseWire>,
    after: Vec<IndexedReleaseWire>,
    fail: bool,
    recorded: Mutex<usize>,
}

impl ReleaseIndexSource for StubIndex {
    fn lookup(
        &self,
        _imdb: &str,
        _season: Option<i64>,
        _episode: Option<i64>,
        _now_ms: i64,
    ) -> Vec<IndexedReleaseWire> {
        let n = self.lookups.fetch_add(1, Ordering::SeqCst);
        if n == 0 {
            self.before.clone()
        } else {
            self.after.clone()
        }
    }

    fn is_partial(
        &self,
        _imdb: &str,
        _season: Option<i64>,
        _episode: Option<i64>,
        _now_ms: i64,
    ) -> bool {
        false
    }

    fn record(
        &self,
        _entry: &ReleaseEntry,
        _now_ms: i64,
        _bank: Option<BankLookup<'_>>,
    ) -> Result<usize, String> {
        if self.fail {
            return Err("indice fechado".into());
        }
        *self.recorded.lock().unwrap() += 1;
        Ok(1)
    }
}

fn settings() -> RelevanceSettings {
    RelevanceSettings {
        now_ms: NOW,
        pre_home_release_cut: false,
        pre_home_release_margin_ms: 0,
        title_precision_tail_cut: false,
    }
}

fn run(
    index: Arc<StubIndex>,
    streams: Option<Arc<StreamsStore>>,
    pending: &mut HashSet<String>,
    imdb: &str,
) -> super::RecordedDrain {
    let entry = movie(imdb);
    record_collected(RecordArgs {
        index: index.as_ref(),
        bank: None,
        streams: streams.as_ref(),
        pending_invalidate: pending,
        entry: &entry,
        items: Vec::new(),
        attempted: 2,
        jackett_complete: true,
        settings: settings(),
        names: &[],
        year: "1994",
        alt_year: None,
        multi_work_root: None,
        home_release_at: None,
        now_ms: NOW,
        journal: None,
        run_id: "",
    })
}

fn put_stream(store: &StreamsStore, suffix: &str) {
    let key = format!("{}{suffix}", streams_prefix());
    let entry = adom_search::StreamsEntry {
        streams: vec![adom_search::StreamItem {
            info_hash: Some("0123456789abcdef0123456789abcdef01234567".into()),
            ..adom_search::StreamItem::default()
        }],
        partial: false,
        debrid_known: Some(true),
        ..Default::default()
    };
    store.set(&key, &entry, 600, 1_000).unwrap();
}

#[test]
fn escrita_falha_nao_produz_found() {
    let index = Arc::new(StubIndex {
        lookups: AtomicUsize::new(0),
        before: Vec::new(),
        after: vec![wire("abcd", "1080p", 3, true)],
        fail: true,
        recorded: Mutex::new(0),
    });
    let mut pending = HashSet::new();
    let out = run(index, None, &mut pending, "tt0111161");
    assert!(!out.found);
    assert!(!out.outcome.ok);
    assert!(pending.is_empty());
}

#[test]
fn store_ausente_degrada_sem_afirmar_invalidacao() {
    let index = Arc::new(StubIndex {
        lookups: AtomicUsize::new(0),
        before: Vec::new(),
        after: vec![wire("abcd", "1080p", 3, true)],
        fail: false,
        recorded: Mutex::new(0),
    });
    let mut pending = HashSet::new();
    let out = run(index, None, &mut pending, "tt0111161");
    assert!(out.found);
    assert!(out.outcome.ok);
    assert!(pending.is_empty());
}

#[test]
fn transicao_invalida_so_a_obra() {
    let store = Arc::new(StreamsStore::open_memory().unwrap());
    put_stream(&store, "movie:tt0111161:{\"m\":1}:account:a");
    put_stream(&store, "movie:tt0111161:{\"m\":2}:account:b");
    put_stream(&store, "movie:tt0068646:{\"m\":1}:account:a");
    let index = Arc::new(StubIndex {
        lookups: AtomicUsize::new(0),
        before: Vec::new(),
        after: vec![wire("abcd", "1080p", 3, true)],
        fail: false,
        recorded: Mutex::new(0),
    });
    let mut pending = HashSet::new();
    let out = run(index, Some(store.clone()), &mut pending, "tt0111161");
    assert!(out.found);
    assert!(store
        .get(
            &format!("{}movie:tt0111161:{{\"m\":1}}:account:a", streams_prefix()),
            2_000
        )
        .unwrap()
        .is_none());
    assert!(store
        .get(
            &format!("{}movie:tt0068646:{{\"m\":1}}:account:a", streams_prefix()),
            2_000
        )
        .unwrap()
        .is_some());
}

#[test]
fn repeticao_idempotente_e_limpa_found_entre_execucoes() {
    let store = Arc::new(StreamsStore::open_memory().unwrap());
    put_stream(&store, "movie:tt0111161:escopo");
    let index = Arc::new(StubIndex {
        lookups: AtomicUsize::new(0),
        before: vec![wire("abcd", "1080p", 3, true)],
        after: vec![wire("abcd", "1080p", 3, true)],
        fail: false,
        recorded: Mutex::new(0),
    });
    let mut pending = HashSet::new();
    let first = run(
        index.clone(),
        Some(store.clone()),
        &mut pending,
        "tt0111161",
    );
    assert!(!first.found);
    let second = run(index, Some(store), &mut pending, "tt0111161");
    assert!(!second.found);
}

#[test]
fn invalidacao_falha_fica_pendente_e_retry_tira() {
    let store = Arc::new(StreamsStore::open_memory().unwrap());
    let mut pending = HashSet::new();
    pending.insert("tt0111161".into());
    retry_invalidations(Some(&store), &mut pending, None, NOW);
    assert!(pending.is_empty());
    pending.insert("nao-e-imdb".into());
    retry_invalidations(Some(&store), &mut pending, None, NOW);
    assert!(pending.contains("nao-e-imdb"));
}

fn series_season(imdb: &str) -> HarvestEntry {
    HarvestEntry {
        imdb_id: imdb.into(),
        media_type: HarvestMediaType::Series,
        season: Some(1),
        episode: None,
        reason: "br-gap".into(),
        enqueued_at: NOW,
        priority_at: Some(NOW),
        resumed: false,
        br_probe: true,
        full_base: false,
        full_intent: None,
    }
}

fn raw(title: &str, hash: &str) -> RawItem {
    RawItem {
        title: Some(title.into()),
        magnet: Some(format!("magnet:?xt=urn:btih:{hash}&dn=x")),
        info_hash: Some(hash.into()),
        is_br: true,
        seeders: Some(5.0),
        indexer: Some("bludv".into()),
        ..RawItem::default()
    }
}

#[test]
fn sonda_de_temporada_anuncia_found_na_chave_do_episodio() {
    let index = NativeReleaseIndex::from_store(ReleaseIndexStore::open_memory().expect("índice"));
    let streams = Arc::new(StreamsStore::open_memory().unwrap());
    put_stream(&streams, "series:tt0386676:{\"s\":1}:account:a");
    let entry = series_season("tt0386676");
    let mut pending = HashSet::new();
    let out = record_collected(RecordArgs {
        index: &index,
        bank: None,
        streams: Some(&streams),
        pending_invalidate: &mut pending,
        entry: &entry,
        items: vec![raw("The Office S01E01 1080p Dublado", HASH)],
        attempted: 2,
        jackett_complete: true,
        settings: settings(),
        names: &[],
        year: "2005",
        alt_year: None,
        multi_work_root: None,
        home_release_at: None,
        now_ms: NOW,
        journal: None,
        run_id: "",
    });
    assert!(out.found, "delta em S1E1 conta como Found");
    assert!(out.outcome.ok);
    assert!(
        index.lookup("tt0386676", Some(1), None, NOW).is_empty(),
        "sonda de temporada não deixa a release na chave S1"
    );
    let episode = index.lookup("tt0386676", Some(1), Some(1), NOW);
    assert_eq!(episode.len(), 1);
    assert_eq!(episode[0].hash, HASH);
    assert!(
        streams
            .get(
                &format!("{}series:tt0386676:{{\"s\":1}}:account:a", streams_prefix()),
                2_000
            )
            .unwrap()
            .is_none(),
        "invalidação usa o mesmo delta do episódio gravado"
    );
}

#[test]
fn dedupe_depois_do_filtro_guarda_o_titulo_relevante() {
    let index = NativeReleaseIndex::from_store(ReleaseIndexStore::open_memory().expect("índice"));
    let entry = movie("tt7286456");
    let mut pending = HashSet::new();
    let lixo = raw("Batman 2019 1080p Dual Áudio", HASH);
    let bom = raw("Coringa 2019 1080p Dublado", HASH);
    let out = record_collected(RecordArgs {
        index: &index,
        bank: None,
        streams: None,
        pending_invalidate: &mut pending,
        entry: &entry,
        items: vec![lixo, bom],
        attempted: 1,
        jackett_complete: true,
        settings: settings(),
        names: &["Coringa".into()],
        year: "2019",
        alt_year: None,
        multi_work_root: None,
        home_release_at: None,
        now_ms: NOW,
        journal: None,
        run_id: "",
    });
    assert!(out.found);
    let found = index.lookup("tt7286456", None, None, NOW);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].hash, HASH);
    assert!(
        found[0].title.contains("Coringa"),
        "título do Jackett irrelevante não sobrevive ao filtro: {}",
        found[0].title
    );
}

#[test]
fn outbox_registra_o_alvo_antes_de_invalidar() {
    let journal = HarvestStore::open_memory().unwrap();
    let store = Arc::new(StreamsStore::open_memory().unwrap());
    let mut pending = HashSet::new();
    // `invalidate_for_obra` recusa IMDb inválido: a invalidação FALHA — e é
    // exatamente aí que o alvo durável precisa já estar na outbox, senão o
    // `pending` em memória leva o alvo junto no restart.
    apply_transition(
        Some(&store),
        &mut pending,
        "nao-e-imdb",
        BrTransition::Br,
        Some(&journal),
        "run-1",
        NOW,
    );
    assert!(pending.contains("nao-e-imdb"), "retentativa em memória");
    let alvos: Vec<String> = journal
        .outbox_pending(NOW)
        .unwrap()
        .into_iter()
        .map(|item| item.target)
        .collect();
    assert_eq!(alvos, vec!["obra:nao-e-imdb".to_string()]);
}
