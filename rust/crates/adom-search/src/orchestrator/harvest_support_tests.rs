//! Testes do reuso da coleta e da gravação de índice pelo colhedor de fundo.

use std::sync::Mutex;

use adom_core::{BankRow, InstantSource, InstantWork, WorkTarget};
use adom_sources::JackettRawItem;
use serde_json::Value;

use super::{raw_items_from_jackett, record_release, release_entry_for, write_entry};
// Importa pelo caminho do CONSUMIDOR (`orchestrator::*`): é também a prova de
// que os reexports de `RawItem`/`ReleaseEntry`/traits existem fora do crate.
use crate::orchestrator::{
    BankFilterCtx, BankLookup, IndexedReleaseWire, MagnetBankSource, RawItem, ReleaseEntry,
    ReleaseIndexSource,
};

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccc";

fn jackett(title: &str, hash: &str, indexer: &str, tracker: Option<&str>) -> JackettRawItem {
    JackettRawItem {
        title: title.to_string(),
        magnet: Some(format!("magnet:?xt=urn:btih:{hash}&dn=x")),
        info_hash: Some(hash.to_string()),
        seeders: Some(12.0),
        size: Some(1024.0 * 1024.0 * 1024.0),
        published_at: Some(1_700_000_000_000),
        tracker: tracker.map(str::to_string),
        indexer: indexer.to_string(),
        download_url: None,
        is_br: true,
    }
}

fn raw(hash: &str, from_fallback: bool) -> RawItem {
    RawItem {
        title: Some(format!("Filme {hash}")),
        info_hash: Some(hash.to_string()),
        indexer: Some("bludv".into()),
        from_fallback,
        ..RawItem::default()
    }
}

// ── dublês ──────────────────────────────────────────────────────────────────

/// Índice fake: guarda as entradas gravadas e o que o `lookup` devolveu (o
/// índice real o usa para `mediaSource`).
#[derive(Default)]
struct FakeIndex {
    records: Mutex<Vec<ReleaseEntry>>,
    lookups: Mutex<Vec<Vec<BankRow>>>,
    fail: bool,
}

impl ReleaseIndexSource for FakeIndex {
    fn lookup(
        &self,
        _imdb: &str,
        _season: Option<i64>,
        _episode: Option<i64>,
        _now: i64,
    ) -> Vec<IndexedReleaseWire> {
        Vec::new()
    }

    fn is_partial(
        &self,
        _imdb: &str,
        _season: Option<i64>,
        _episode: Option<i64>,
        _now: i64,
    ) -> bool {
        false
    }

    fn record(
        &self,
        entry: &ReleaseEntry,
        _now: i64,
        bank: Option<BankLookup<'_>>,
    ) -> Result<usize, String> {
        let hashes: Vec<String> = entry
            .items
            .iter()
            .filter_map(|item| item.get("infoHash").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        let rows = bank.map(|lookup| lookup(&hashes)).unwrap_or_default();
        self.lookups.lock().expect("lookups").push(rows);
        self.records.lock().expect("records").push(entry.clone());
        if self.fail {
            return Err("índice fora".into());
        }
        Ok(entry.items.len())
    }
}

struct Mark {
    entered: usize,
    survivors: usize,
    ctx: BankFilterCtx,
    now_ms: i64,
}

/// Banco fake: conta as marcas de `passed_filter` e devolve uma linha por hash.
#[derive(Default)]
struct FakeBank {
    marks: Mutex<Vec<Mark>>,
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
        Vec::new()
    }

    fn sources_for_many(
        &self,
        _hashes: &[String],
    ) -> std::collections::BTreeMap<String, Vec<InstantSource>> {
        std::collections::BTreeMap::new()
    }

    fn bank_rows_many(&self, hashes: &[String]) -> Vec<BankRow> {
        hashes
            .iter()
            .map(|hash| BankRow {
                hash: hash.clone(),
                uri: format!("magnet:?xt=urn:btih:{hash}"),
                title: "linha do banco".into(),
            })
            .collect()
    }

    fn mark_filter_outcome(
        &self,
        entered: &[Value],
        survivors: &[Value],
        ctx: &BankFilterCtx,
        now_ms: i64,
    ) -> bool {
        self.marks.lock().expect("marks").push(Mark {
            entered: entered.len(),
            survivors: survivors.len(),
            ctx: ctx.clone(),
            now_ms,
        });
        true
    }

    fn has_br_row(&self, _imdb: &str, _targets: &[WorkTarget]) -> bool {
        false
    }
}

// ── (a) Jackett → RawItem ───────────────────────────────────────────────────

#[test]
fn raw_items_from_jackett_preserva_hash_titulo_e_indexer() {
    let out = raw_items_from_jackett(vec![
        jackett("Filme 2024 1080p", HASH_A, "bludv", None),
        jackett("Outro 2023", HASH_B, "comandotorrents", Some("")),
        jackett("Com tracker", HASH_C, "nerdfilmes", Some("Rede Torrent")),
    ]);
    assert_eq!(out.len(), 3);
    assert_eq!(out[0].info_hash.as_deref(), Some(HASH_A));
    assert_eq!(out[0].title.as_deref(), Some("Filme 2024 1080p"));
    assert_eq!(out[0].indexer.as_deref(), Some("bludv"));
    assert!(out[0].is_br, "o flag BR do indexer atravessa");
    // Tracker ausente ou vazio não inventa `tracker:`.
    assert!(out[0].sources.is_empty());
    assert!(out[1].sources.is_empty());
    assert_eq!(out[2].sources, vec!["tracker:Rede Torrent".to_string()]);
    // Tamanho, seeders e data atravessam como o coletor nativo entrega.
    assert_eq!(out[0].size_bytes, Some(1024.0 * 1024.0 * 1024.0));
    assert_eq!(out[0].seeders, Some(12.0));
    assert_eq!(out[0].published_at, Some(1_700_000_000_000.0));
}

// ── (b) entrada do índice ──────────────────────────────────────────────────

#[test]
fn release_entry_for_filme_e_serie_preenche_a_chave_do_indice() {
    let entered = vec![raw(HASH_A, false), raw(HASH_B, false), raw(HASH_C, true)];
    let survivors = vec![raw(HASH_A, false), raw(HASH_C, true)];

    let filme = release_entry_for(
        "tt0111161",
        "movie",
        Some(2),
        Some(5),
        Some("1994"),
        &entered,
        &survivors,
    );
    assert_eq!(filme.imdb, "tt0111161");
    assert_eq!(filme.season, None, "filme não cai em balde de temporada");
    assert_eq!(filme.episode, None);
    assert_eq!(filme.source, None);
    // A reserva 📦 (`fromFallback`) sai das TRÊS listas: zero auto-perpetuação.
    assert_eq!(filme.items.len(), 1);
    assert_eq!(filme.entered.as_ref().map(Vec::len), Some(2));
    assert_eq!(filme.survivors.as_ref().map(Vec::len), Some(1));

    let serie = release_entry_for(
        "tt0903747",
        "series",
        Some(2),
        Some(5),
        None,
        &entered,
        &survivors,
    );
    assert_eq!(serie.imdb, "tt0903747");
    assert_eq!(serie.season, Some(2));
    assert_eq!(serie.episode, Some(5));
    assert_eq!(serie.items.len(), 1);
    assert_eq!(serie.entered.as_ref().map(Vec::len), Some(2));

    // Só `"movie"` (sem caixa) zera S/E: tipo desconhecido não destrói dado.
    let sem_tipo = release_entry_for("tt1", "", Some(1), Some(4), None, &[], &[]);
    assert_eq!(sem_tipo.season, Some(1));
    assert_eq!(sem_tipo.episode, Some(4));
    let filme_caixa_alta = release_entry_for("tt2", " MOVIE ", Some(3), None, None, &[], &[]);
    assert_eq!(filme_caixa_alta.season, None);
}

// ── (c) gravação ───────────────────────────────────────────────────────────

#[test]
fn record_release_grava_no_indice_e_marca_o_filtro() {
    let index = FakeIndex::default();
    let bank = FakeBank::default();
    let entered = vec![raw(HASH_A, false), raw(HASH_B, false)];
    let survivors = vec![raw(HASH_A, false)];
    let entry = release_entry_for(
        "tt0903747",
        "series",
        Some(2),
        Some(5),
        Some("2008"),
        &entered,
        &survivors,
    );
    let now = 1_700_000_000_000;

    let gravadas = record_release(&index, &entry, Some(&bank), now).expect("grava a entrada");

    assert_eq!(gravadas, entry.items.len());
    assert_eq!(index.records.lock().expect("records").len(), 1);
    // O `lookup` do banco chega ao índice (é o `mediaSource` do R4).
    assert_eq!(
        index.lookups.lock().expect("lookups")[0].len(),
        entry.items.len()
    );
    let marks = bank.marks.lock().expect("marks");
    assert_eq!(marks.len(), 1, "uma marca por entrada gravada");
    assert_eq!(marks[0].entered, 2);
    assert_eq!(marks[0].survivors, 1);
    assert_eq!(
        marks[0].ctx,
        BankFilterCtx {
            imdb_id: "tt0903747".into(),
            season: Some(2),
            episode: Some(5),
        }
    );
    assert_eq!(marks[0].now_ms, now);
}

#[test]
fn record_release_sem_banco_grava_so_o_indice() {
    let index = FakeIndex::default();
    let entered = vec![raw(HASH_A, false)];
    let entry = release_entry_for("tt1", "movie", None, None, None, &entered, &entered);

    let gravadas = record_release(&index, &entry, None, 7).expect("grava a entrada");

    assert_eq!(gravadas, 1);
    assert_eq!(index.records.lock().expect("records").len(), 1);
    // Sem banco o lookup resolve vazio — mas continua sendo passado ao índice.
    assert!(index.lookups.lock().expect("lookups")[0].is_empty());
}

#[test]
fn record_release_propaga_o_erro_e_mantem_a_marca() {
    let index = FakeIndex {
        fail: true,
        ..FakeIndex::default()
    };
    let bank = FakeBank::default();
    let entered = vec![raw(HASH_A, false)];
    let entry = release_entry_for("tt1", "movie", None, None, None, &entered, &entered);

    let erro = record_release(&index, &entry, Some(&bank), 42).unwrap_err();

    assert!(erro.contains("índice fora"));
    assert_eq!(
        bank.marks.lock().expect("marks").len(),
        1,
        "a marca do filtro sai mesmo com o record errado"
    );
    let sem_banco = write_entry(&index, &entry, None, 42);
    assert!(!sem_banco.bank_present, "sem banco é degradação contada");
    assert!(!sem_banco.bank_marked);
}
