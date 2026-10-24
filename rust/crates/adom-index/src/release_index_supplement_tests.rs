//! Registro suplementar do `idx:v14`: sonda/FULL incompleto não certifica
//! chave nova como completa e não rebaixa chave já honesta.
//!
//! A intenção NÃO se reconstrói de `source`/título/áudio — só o flag
//! `RecordOptions.supplemental` decide esta política.

use super::*;
use serde_json::{json, Value};

const TTL: u64 = 30 * 24 * 3600;
const NOW: i64 = 1_700_000_000_000;
const HA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HB: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HC: &str = "cccccccccccccccccccccccccccccccccccccccc";
const HD: &str = "dddddddddddddddddddddddddddddddddddddddd";
const HE: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const H1: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const H2: &str = "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2";
const HP: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const HF: &str = "acacacacacacacacacacacacacacacacacacacac";

fn store() -> ReleaseIndexStore {
    ReleaseIndexStore::open_memory().expect("memória")
}

fn movie() -> WorkTarget {
    WorkTarget {
        season: None,
        episode: None,
    }
}

fn item(title: &str, hash: &str) -> Value {
    json!({ "title": title, "infoHash": hash, "isBr": true, "seeders": 4 })
}

fn write(
    store: &ReleaseIndexStore,
    imdb: &str,
    location: WorkTarget,
    items: &[Value],
    opts: RecordOptions<'_>,
    now: i64,
) -> usize {
    store
        .record(imdb, location, items, opts, TTL, 60, now, None)
        .expect("record")
}

fn supplemental(partial: bool) -> RecordOptions<'static> {
    RecordOptions {
        partial,
        keep_partial: false,
        source: None,
        supplemental: true,
    }
}

fn complete() -> RecordOptions<'static> {
    RecordOptions {
        partial: false,
        keep_partial: false,
        source: None,
        supplemental: false,
    }
}

#[test]
fn suplementar_chave_nova_nasce_parcial() {
    let store = store();
    let added = write(
        &store,
        "tt0111161",
        movie(),
        &[item("Filme 1994 1080p Dublado", HA)],
        supplemental(false),
        NOW,
    );
    assert_eq!(added, 1);
    let entry = store
        .read_entry("idx:v14:tt0111161", NOW)
        .expect("chave nova");
    assert!(
        entry.partial,
        "sonda/FULL incompleto não certifica chave nova"
    );
}

#[test]
fn suplementar_preserva_parcial_existente() {
    let store = store();
    write(
        &store,
        "tt0111161",
        movie(),
        &[item("Filme 1994 720p", HB)],
        RecordOptions {
            partial: true,
            keep_partial: false,
            source: None,
            supplemental: false,
        },
        NOW,
    );
    write(
        &store,
        "tt0111161",
        movie(),
        &[item("Filme 1994 1080p Dublado", HB)],
        supplemental(false),
        NOW + 1,
    );
    let entry = store
        .read_entry("idx:v14:tt0111161", NOW + 1)
        .expect("parcial");
    assert!(entry.partial, "escrita suplementar não limpa parcial");
}

#[test]
fn suplementar_nao_rebaixa_completa() {
    let store = store();
    write(
        &store,
        "tt0111161",
        movie(),
        &[item("Filme 1994 1080p", HC)],
        complete(),
        NOW,
    );
    write(
        &store,
        "tt0111161",
        movie(),
        &[item("Filme 1994 1080p Dual", HC)],
        supplemental(false),
        NOW + 1,
    );
    let entry = store
        .read_entry("idx:v14:tt0111161", NOW + 1)
        .expect("completa");
    assert!(
        !entry.partial,
        "sonda depois de FULL não suja chave completa"
    );
}

#[test]
fn lote_de_serie_respeita_estado_de_cada_chave() {
    let store = store();
    let loc = WorkTarget {
        season: Some(1),
        episode: Some(1),
    };
    write(
        &store,
        "tt0944947",
        loc,
        &[item("Serie S01E01 1080p", H1)],
        complete(),
        NOW,
    );
    write(
        &store,
        "tt0944947",
        WorkTarget {
            season: Some(1),
            episode: Some(2),
        },
        &[item("Serie S01E02 1080p", H2)],
        RecordOptions {
            partial: true,
            ..complete()
        },
        NOW,
    );

    let lote = vec![
        item("Serie S01E01 1080p Dual", HA),
        item("Serie S01E02 1080p Dual", HB),
        item("Serie 1ª Temporada 1080p", HP),
        json!({
            "title": "Serie Completa 1080p",
            "infoHash": HF,
            "fromAccount": true,
        }),
    ];
    write(
        &store,
        "tt0944947",
        loc,
        &lote,
        supplemental(false),
        NOW + 1,
    );

    let e1 = store
        .read_entry("idx:v14:tt0944947:S1E1", NOW + 1)
        .expect("S1E1");
    let e2 = store
        .read_entry("idx:v14:tt0944947:S1E2", NOW + 1)
        .expect("S1E2");
    let pack = store
        .read_entry("idx:v14:tt0944947:S1", NOW + 1)
        .expect("pack S1");
    assert!(!e1.partial, "completa existente permanece completa");
    assert!(e2.partial, "parcial existente permanece parcial");
    assert!(pack.partial, "chave nova do lote nasce parcial");
    assert!(
        store.read_entry("idx:v14:tt0944947", NOW + 1).is_none(),
        "fromAccount não abre a raiz"
    );
}

#[test]
fn lote_vazio_nao_apaga_nem_limpa_parcial() {
    let store = store();
    write(
        &store,
        "tt0111161",
        movie(),
        &[item("Filme 1994 1080p", HD)],
        RecordOptions {
            partial: true,
            ..complete()
        },
        NOW,
    );
    let added = write(
        &store,
        "tt0111161",
        movie(),
        &[],
        supplemental(false),
        NOW + 1,
    );
    assert_eq!(added, 0);
    let entry = store
        .read_entry("idx:v14:tt0111161", NOW + 1)
        .expect("parcial intacta");
    assert!(entry.partial);
    assert_eq!(entry.releases.len(), 1);

    let vazia = ReleaseIndexStore::open_memory().expect("memória");
    assert_eq!(write(&vazia, "tt0111161", movie(), &[], complete(), NOW), 0);
    assert!(
        vazia.read_entry("idx:v14:tt0111161", NOW).is_none(),
        "lote vazio não certifica índice ausente"
    );
}

#[test]
fn sonda_depois_full_completa_a_chave() {
    let store = store();
    write(
        &store,
        "tt0111161",
        movie(),
        &[item("Filme 1994 720p", HE)],
        supplemental(false),
        NOW,
    );
    assert!(store.read_entry("idx:v14:tt0111161", NOW).unwrap().partial);
    write(
        &store,
        "tt0111161",
        movie(),
        &[item("Filme 1994 1080p Dublado", HE)],
        complete(),
        NOW + 1,
    );
    assert!(
        !store
            .read_entry("idx:v14:tt0111161", NOW + 1)
            .unwrap()
            .partial,
        "FULL completo depois da sonda certifica"
    );
}
