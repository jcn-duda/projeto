use super::*;
use serde_json::json;

fn playable_item() -> StreamItem {
    StreamItem {
        info_hash: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
        ..StreamItem::default()
    }
}

fn notice_item() -> StreamItem {
    StreamItem {
        name: Some("Procurando fontes — reabra em instantes".to_string()),
        external_url: Some("https://host.example/configure".to_string()),
        ..StreamItem::default()
    }
}

fn complete_entry() -> StreamsEntry {
    StreamsEntry {
        streams: vec![playable_item()],
        partial: false,
        debrid_known: Some(true),
        fallback: false,
        ..Default::default()
    }
}

#[test]
fn hit_fresco_serve_sem_revalidar() {
    let store = MemorySwrStore::new();
    store.set("k", &complete_entry(), 60, 1_000);
    let hit = store
        .get_with_stale("k", STREAM_STALE_GRACE_SECONDS, 61_000)
        .expect("hit");
    assert!(!hit.stale);
    assert_eq!(
        swr_lookup(Some(hit)),
        SwrLookup::Serve {
            entry: complete_entry(),
            revalidate: false
        }
    );
}

#[test]
fn hit_stale_serve_e_sinaliza_revalidacao() {
    let store = MemorySwrStore::new();
    store.set("k", &complete_entry(), 60, 1_000);
    // TTL 60s: vence em 61_000; dentro da graça de 300s até 361_000.
    let hit = store
        .get_with_stale("k", STREAM_STALE_GRACE_SECONDS, 200_000)
        .expect("hit stale");
    assert!(hit.stale);
    assert_eq!(
        swr_lookup(Some(hit)),
        SwrLookup::Serve {
            entry: complete_entry(),
            revalidate: true
        }
    );
    // Stale não apaga: leitura seguinte ainda encontra a entrada.
    assert!(store.get_with_stale("k", 300, 200_001).is_some());
}

#[test]
fn miss_sem_entrada_e_depois_da_graca() {
    let store = MemorySwrStore::new();
    assert_eq!(swr_lookup(None), SwrLookup::Miss);
    store.set("k", &complete_entry(), 60, 1_000);
    // Um milissegundo além da graça: apaga e vira miss.
    assert_eq!(
        swr_lookup(store.get_with_stale("k", 300, 61_000 + 300_000 + 1)),
        SwrLookup::Miss
    );
    assert_eq!(store.len(), 0, "entrada além da graça deve ser apagada");
}

#[test]
fn entrada_incompleta_nunca_e_servida() {
    // Parcial, sem debrid conferido e só aviso: nenhuma variação serve,
    // nem fresca (a lista sem stream tocável não estende estado ruim).
    let casos = vec![
        StreamsEntry {
            partial: true,
            ..complete_entry()
        },
        StreamsEntry {
            debrid_known: Some(false),
            ..complete_entry()
        },
        StreamsEntry {
            debrid_known: None,
            ..complete_entry()
        },
        StreamsEntry {
            streams: vec![notice_item()],
            ..complete_entry()
        },
        StreamsEntry {
            streams: vec![],
            ..complete_entry()
        },
    ];
    for entry in casos {
        store_check(&entry);
    }
}

fn store_check(entry: &StreamsEntry) {
    let store = MemorySwrStore::new();
    store.set("k", entry, 60, 1_000);
    assert_eq!(
        swr_lookup(store.get_with_stale("k", 300, 2_000)),
        SwrLookup::Miss
    );
    // Stale idem: elegibilidade exige completa + tocável dos dois lados.
    assert_eq!(
        swr_lookup(store.get_with_stale("k", 300, 200_000)),
        SwrLookup::Miss
    );
    // E a régua do núcleo (a mesma do search-commit.ts) concorda: o
    // `playable` vem do MESMO teste que o chamador usa (`hasPlayableStream`),
    // e aviso não conta como tocável.
    let json = serde_json::to_value(entry).unwrap();
    assert!(!adom_core::stale_refresh_eligible(
        Some(&json),
        has_playable_stream(&entry.streams)
    ));
}

#[test]
fn ttl_respeita_decisao_sem_teto_fixo() {
    let store = MemorySwrStore::new();
    // Lista completa ganha TTL cheio (ex.: 900s), sem grampo artificial em 60s.
    store.set("k_completa", &complete_entry(), 900, 1_000);
    // Aos 60s e aos 899s ainda é fresco (stale: false) mesmo com graça 0.
    let hit = store
        .get_with_stale("k_completa", 0, 1_000 + 60_000)
        .unwrap();
    assert!(!hit.stale);
    let hit = store
        .get_with_stale("k_completa", 0, 1_000 + 899_000)
        .unwrap();
    assert!(!hit.stale);
    // Após 900s, com graça 0 expira.
    assert!(store
        .get_with_stale("k_completa", 0, 1_000 + 900_001)
        .is_none());

    // Parcial ganha TTL curto (ex.: 60s) decidido por commit_decision.
    let mut parcial = complete_entry();
    parcial.partial = true;
    store.set("k_parcial", &parcial, 60, 1_000);
    assert!(store
        .get_with_stale("k_parcial", 0, 1_000 + 60_000)
        .is_some());
    assert!(store
        .get_with_stale("k_parcial", 0, 1_000 + 60_001)
        .is_none());
}

#[test]
fn host_nunca_vai_para_o_cache() {
    let entry = StreamsEntry {
        streams: vec![
            StreamItem {
                url: Some("https://meu-host.example/resolve/eyJhIjoxfQ/abc".to_string()),
                ..playable_item()
            },
            notice_item(),
        ],
        ..complete_entry()
    };
    let gravada = to_cacheable_entry(&entry);
    let json = serde_json::to_value(&gravada).unwrap();
    let texto = json.to_string();
    assert!(!texto.contains("meu-host.example"), "host vazou: {texto}");
    assert_eq!(
        gravada.streams[0].url.as_deref(),
        Some("/resolve/eyJhIjoxfQ/abc")
    );
    assert_eq!(
        gravada.streams[1].external_url.as_deref(),
        Some("/configure")
    );
    // Forma do valor `streams:v21`: lista pronta + debridKnown + completude.
    assert_eq!(json["debridKnown"], json!(true));
    assert_eq!(json["partial"], json!(false));
    assert_eq!(json["fallback"], json!(false));
    assert!(json["streams"].is_array());
}

#[test]
fn relative_url_casos_de_borda() {
    assert_eq!(relative_url("/resolve/x"), "/resolve/x");
    assert_eq!(relative_url("http://h.test/a?b=c"), "/a?b=c");
    assert_eq!(relative_url("https://h.test"), "");
}

#[test]
fn chave_por_config_e_conta_reusada_do_request() {
    // A chave vem de `request_cache_key` (streamsCacheKey do TS): config +
    // digest da conta; nenhum pedaço de host e nenhuma credencial crua.
    let opts = json!({ "d": "1", "debridApiKey": "segredo" });
    let key = crate::request::request_cache_key("movie", "tt1", &opts);
    assert!(key.starts_with("streams:v21:movie:tt1:"));
    assert!(!key.contains("segredo"));
    assert!(!key.contains("http"));
}
