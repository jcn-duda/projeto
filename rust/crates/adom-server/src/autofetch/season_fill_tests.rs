//! Preenchimento de temporada (lado do PACK): o pack que PREENCHE invalida as
//! buscas da temporada e consome o índice; o que NÃO preenche não apaga nada.
//!
//! O cache de streams aqui é um `StreamsStore` em memória de verdade: o teste
//! mede linha apagada, não a lista que o sink recebeu (sink de mentira provaria
//! só a chamada, não a invalidação).

use std::sync::Arc;

use adom_index::NativeKv;
use adom_search::StreamsEntry;
use adom_store::StreamsStore;

use super::super::season_step::{self, SeasonRegister, SeasonStepConfig};
use super::{fill, CacheProof, SeasonFillSink, SeasonHint};

const NOW: i64 = 1_700_000_000_000;
const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "digest-da-conta";
const IMDB: &str = "tt0903747";
const PACK_S2: &str = "Breaking Bad Season 2 Complete 1080p Dublado";

fn config() -> SeasonStepConfig {
    SeasonStepConfig {
        enabled: true,
        paused: false,
        max_seasons: 200,
        max_keys: 256,
        ttl_seconds: 21_600,
    }
}

fn kv() -> NativeKv {
    NativeKv::open_memory().expect("kv")
}

fn cached_key(name: &str) -> String {
    format!("streams:v21:series:{IMDB}:{name}")
}

/// O efeito `season_key`: registra as buscas da temporada no índice do KV.
fn register(kv: &NativeKv, season: i64, keys: &[String]) {
    register_as(kv, ADAPTER, season, keys);
}

/// Idem com o SERVIÇO explícito: a chave do índice é POR adaptador, e o teste
/// do veredito do Real-Debrid precisa registrar pela conta do RD.
fn register_as(kv: &NativeKv, adapter: &str, season: i64, keys: &[String]) {
    for key in keys {
        let register = SeasonRegister {
            adapter_id: adapter.into(),
            account: ACCOUNT.into(),
            imdb_id: IMDB.into(),
            season,
            cache_key: key.clone(),
        };
        let report = season_step::execute(kv, &register, &config(), NOW).expect("registra");
        assert!(report.registered);
    }
}

/// Cache de streams REAL em memória + sink que apaga de verdade.
fn streams(keys: &[String]) -> (Arc<StreamsStore>, SeasonFillSink) {
    let store = Arc::new(StreamsStore::open_memory().expect("streams"));
    for key in keys {
        store
            .set(key, &StreamsEntry::default(), 600, NOW as u64)
            .expect("semeia cache");
    }
    let handle = Arc::clone(&store);
    let sink: SeasonFillSink = Arc::new(move |keys: &[String]| {
        for key in keys {
            handle.forget(key)?;
        }
        Ok(())
    });
    (store, sink)
}

fn cached(store: &StreamsStore, key: &str) -> bool {
    store.get(key, NOW as u64).expect("lê cache").is_some()
}

fn hint(season: Option<i64>, title: &str) -> SeasonHint {
    SeasonHint {
        imdb_id: Some(IMDB.to_string()),
        season,
        title: title.to_string(),
    }
}

fn index_alive(kv: &NativeKv, season: i64) -> bool {
    index_alive_as(kv, ADAPTER, season)
}

fn index_alive_as(kv: &NativeKv, adapter: &str, season: i64) -> bool {
    kv.get_json(&season_step::index_key(adapter, ACCOUNT, IMDB, season), NOW)
        .expect("lê índice")
        .is_some()
}

/// O pack que PREENCHE invalida TODAS as buscas da temporada e consome o índice.
#[test]
fn pack_que_preenche_invalida_as_buscas_da_temporada() {
    let kv = kv();
    let keys = vec![cached_key("s2-1080p"), cached_key("s2-dublado")];
    register(&kv, 2, &keys);
    let (store, sink) = streams(&keys);

    let report = fill(
        &kv,
        &config(),
        Some(&sink),
        ADAPTER,
        ACCOUNT,
        CacheProof::Proven,
        &[hint(Some(2), PACK_S2)],
        NOW,
    );

    assert_eq!(report.filled, 1);
    assert_eq!(report.invalidated, 2);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    for key in &keys {
        assert!(!cached(&store, key), "{key} continua no cache de streams");
    }
    assert!(
        !index_alive(&kv, 2),
        "índice da temporada tinha de ser consumido pelo pack que preencheu"
    );
}

/// Pack de OUTRA temporada não preenche o buraco — e não apaga nada.
///
/// `isSeasonPackFillEligible` é da temporada PEDIDA (o TS passa `season ??
/// null`): um pack de S3 não é pack do buraco de S2, então o skip é `not-pack`
/// — nunca um "temporada errada" aceito pela porta de trás.
#[test]
fn pack_de_outra_temporada_nao_apaga_nada() {
    let kv = kv();
    let keys = vec![cached_key("s2-1080p")];
    register(&kv, 2, &keys);
    let (store, sink) = streams(&keys);

    let report = fill(
        &kv,
        &config(),
        Some(&sink),
        ADAPTER,
        ACCOUNT,
        CacheProof::Proven,
        &[hint(Some(2), "Breaking Bad Season 3 Complete 1080p")],
        NOW,
    );

    assert_eq!(report.filled, 0);
    assert_eq!(report.invalidated, 0);
    assert_eq!(report.skips.get("not-pack"), Some(&1));
    assert!(cached(&store, &keys[0]), "busca de S2 não podia sair");
    assert!(index_alive(&kv, 2), "índice de S2 não podia ser consumido");
}

/// Release de episódio avulso não é pack: skip com motivo, cache intacto.
#[test]
fn release_de_episodio_nao_preenche() {
    let kv = kv();
    let keys = vec![cached_key("s2-1080p")];
    register(&kv, 2, &keys);
    let (store, sink) = streams(&keys);

    let report = fill(
        &kv,
        &config(),
        Some(&sink),
        ADAPTER,
        ACCOUNT,
        CacheProof::Proven,
        &[hint(Some(2), "Breaking Bad S02E05 1080p Dublado")],
        NOW,
    );

    assert_eq!(report.filled, 0);
    assert_eq!(report.skips.get("not-pack"), Some(&1));
    assert!(cached(&store, &keys[0]));
    assert!(index_alive(&kv, 2));
}

/// Sem sink (worker sem `streams.db`) não há quem apague: o índice fica VIVO.
#[test]
fn sem_sink_o_indice_fica_intacto() {
    let kv = kv();
    let keys = vec![cached_key("s2-1080p")];
    register(&kv, 2, &keys);

    let report = fill(
        &kv,
        &config(),
        None,
        ADAPTER,
        ACCOUNT,
        CacheProof::Proven,
        &[hint(Some(2), PACK_S2)],
        NOW,
    );

    assert_eq!(report.filled, 0);
    assert_eq!(report.skips.get("season-no-sink"), Some(&1));
    assert!(
        index_alive(&kv, 2),
        "sem invalidação confirmada o índice não pode ser consumido"
    );
}

/// Falha do cache de streams vira erro e PRESERVA o índice para a próxima
/// passagem (consumir antes perderia o registro).
#[test]
fn falha_na_invalidacao_preserva_o_indice() {
    let kv = kv();
    let keys = vec![cached_key("s2-1080p")];
    register(&kv, 2, &keys);
    let sink: SeasonFillSink = Arc::new(|_: &[String]| Err("streams.db fora".to_string()));

    let report = fill(
        &kv,
        &config(),
        Some(&sink),
        ADAPTER,
        ACCOUNT,
        CacheProof::Proven,
        &[hint(Some(2), PACK_S2)],
        NOW,
    );

    assert_eq!(report.filled, 0);
    assert_eq!(report.invalidated, 0);
    assert_eq!(report.errors.len(), 1);
    assert!(report.errors[0].contains("streams.db fora"), "{report:?}");
    assert!(index_alive(&kv, 2));
}

/// Temporada sem busca registrada não inventa invalidação: nada sai do cache.
#[test]
fn temporada_sem_busca_registrada_nao_apaga_nada() {
    let kv = kv();
    let keys = vec![cached_key("s2-1080p")];
    let (store, sink) = streams(&keys);

    let report = fill(
        &kv,
        &config(),
        Some(&sink),
        ADAPTER,
        ACCOUNT,
        CacheProof::Proven,
        &[hint(Some(2), PACK_S2)],
        NOW,
    );

    assert_eq!(report.filled, 0);
    assert_eq!(report.invalidated, 0);
    assert_eq!(report.skips.get("season-empty"), Some(&1));
    assert!(
        cached(&store, &keys[0]),
        "sem índice não há o que invalidar"
    );
}

/// Toggle do Season Pack Fill desligado: índice e cache intactos.
#[test]
fn toggle_desligado_nao_invalida() {
    let kv = kv();
    let keys = vec![cached_key("s2-1080p")];
    register(&kv, 2, &keys);
    let (store, sink) = streams(&keys);
    let off = SeasonStepConfig {
        enabled: false,
        ..config()
    };

    let report = fill(
        &kv,
        &off,
        Some(&sink),
        ADAPTER,
        ACCOUNT,
        CacheProof::Proven,
        &[hint(Some(2), PACK_S2)],
        NOW,
    );

    assert_eq!(report.filled, 0);
    assert_eq!(report.skips.get("fill-off"), Some(&1));
    assert!(cached(&store, &keys[0]));
    assert!(index_alive(&kv, 2));
}

/// Serviço sem cache honesto (`cacheCheck: false` DECLARADO no adaptador) não
/// invalida: não há cache de streams com ⚡ para derrubar.
#[test]
fn servico_sem_cache_honesto_nao_e_pack() {
    let kv = kv();
    let keys = vec![cached_key("s2-1080p")];
    register(&kv, 2, &keys);
    let (store, sink) = streams(&keys);

    let report = fill(
        &kv,
        &config(),
        Some(&sink),
        "debridlink",
        ACCOUNT,
        CacheProof::Unproven("adapter"),
        &[hint(Some(2), PACK_S2)],
        NOW,
    );

    assert_eq!(report.filled, 0);
    assert_eq!(report.skips.get("not-pack"), Some(&1));
    assert!(cached(&store, &keys[0]));
    assert!(index_alive(&kv, 2));
}

/// Lote COMPARTILHADO com o Node: o hint de lá (`{imdbId, season, episode,
/// isPack}`, SEM título) desserializa sem erro e NÃO preenche — sem título não
/// há prova de pack, e o `isPack` de outro processo não é fato deste.
#[test]
fn hint_no_formato_do_node_desserializa_e_nao_preenche() {
    let kv = kv();
    let keys = vec![cached_key("s2-1080p")];
    register(&kv, 2, &keys);
    let (store, sink) = streams(&keys);
    let raw = r#"{"imdbId":"tt0903747","season":2,"episode":null,"isPack":true}"#;
    let value: serde_json::Value = serde_json::from_str(raw).expect("json do Node");
    let hint: SeasonHint = serde_json::from_value(value).expect("formato do Node");

    let report = fill(
        &kv,
        &config(),
        Some(&sink),
        ADAPTER,
        ACCOUNT,
        CacheProof::Proven,
        &[hint],
        NOW,
    );

    assert_eq!(report.filled, 0);
    assert_eq!(report.skips.get("not-pack"), Some(&1));
    assert!(
        cached(&store, &keys[0]),
        "sem prova de pack nada sai do cache"
    );
    assert!(index_alive(&kv, 2), "o índice fica para a próxima passagem");
}

/// O veredito do `cacheCheck` (prova viva x `known: false`) tem arquivo próprio
/// para não estourar o teto de linhas.
#[path = "season_fill_cache_tests.rs"]
mod cache;
