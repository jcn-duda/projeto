//! Round-trip do formato v3 da fila contra o schema TS real.
//!
//! Os fixtures são o JSON EXATO que o Node grava: `toQueueCandidate`
//! (`autofetch-fallback.ts`) monta o candidato e `writeQueue` (`autofetch.ts`)
//! grava `JSON.stringify` na chave `autofetch:v3:q:<sha256(searchKey)>`. A prova
//! de round-trip é VALUE equality (a ordem de chaves do objeto JS não é
//! contrato — o leitor é `JSON.parse`), não byte equality.

use adom_autofetch::v3::{
    dead_key, marker_key, marker_value, prefetch_key, queue_key, queue_prefix, sha256_hex,
    QueueCandidate, QueueV3,
};
use adom_store::kv::NativeKv;
use serde_json::{json, Value};

fn queue_v3() -> QueueV3<'static> {
    // Leak deliberado: cada teste ganha um `:memory:` fresco e vive até o fim
    // do processo — o QueueV3 pede o KV emprestado.
    let kv: &'static NativeKv = Box::leak(Box::new(NativeKv::open_memory().unwrap()));
    QueueV3::new(kv)
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn candidates(text: &str) -> Vec<QueueCandidate> {
    serde_json::from_str(text).unwrap()
}

fn reserialize(candidates: &[QueueCandidate]) -> Value {
    serde_json::to_value(candidates).unwrap()
}

// O `queueKey` do Node: `crypto.createHash('sha256').update(s).digest('hex')`
// (hex minúsculo). Digest medido rodando o TS de verdade.
const SHA_TT0903747: &str = "bfb5e13ff7fd01394c885fd8f0d8aa85b32d44f46624f04b09d66a85bb98e08a";

#[test]
fn chave_da_fila_e_sha256_hex_minusculo_da_busca() {
    assert_eq!(sha256_hex("streams:v5:series:tt0903747:1:1"), SHA_TT0903747);
    assert_eq!(
        queue_key("streams:v5:series:tt0903747:1:1"),
        format!("autofetch:v3:q:{SHA_TT0903747}")
    );
    assert_eq!(queue_prefix(), "autofetch:v3:q:");
    // String vazia: o digest de "" (mesmo do Node).
    assert_eq!(
        queue_key(""),
        "autofetch:v3:q:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn chaves_dead_marker_e_prefetch_batem_com_o_formato_do_node() {
    let hash = "A".repeat(40);
    assert_eq!(
        dead_key("alldebrid", "acc1", &hash),
        format!("autofetch:v3:dead:alldebrid:acc1:{}", hash.to_lowercase())
    );
    assert_eq!(
        marker_key("torbox", "acc2", &hash),
        format!("autofetch:v3:m:torbox:acc2:{}", hash.to_lowercase())
    );
    assert_eq!(
        prefetch_key("user_acc", "tt0903747", 1, 2),
        "autofetch:v3:pf:user_acc:tt0903747:1:2"
    );
}

/// Fixture completo: tudo que `toQueueCandidate` grava num pack de temporada do
/// pool seeds (com `_bankDub`, raro, slotLimit, sonda e pack com episode nulo).
const FIXTURE_PACK_TS: &str = r#"[
  {
    "probeSeason": 1,
    "probeEpisode": 8,
    "infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "name": "Lanterns S01 1080p WEB-DL DUAL",
    "title": "Lanterns S01 1080p WEB-DL DUBLADO\n👤 9 💾 750.51 MB 📦 pack 70.36 GB (média) ⚙️ bludv",
    "quality": "1080p",
    "size": 75591424471,
    "seeders": 9,
    "br": true,
    "dubbed": true,
    "bankDub": true,
    "lied": false,
    "pool": "seeds",
    "imdbId": "tt1234567",
    "season": 1,
    "episode": null,
    "isPack": true,
    "rare": true,
    "slotLimit": 2,
    "addedAt": 1769404800000
  }
]"#;

#[test]
fn roundtrip_do_candidato_completo_do_pack_seeds() {
    let expected = parse(FIXTURE_PACK_TS);
    let parsed = candidates(FIXTURE_PACK_TS);
    assert_eq!(parsed.len(), 1);
    assert_eq!(reserialize(&parsed), expected, "round-trip sem perda");

    let cand = &parsed[0];
    assert_eq!(cand.hash(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert_eq!(cand.season_i64(), Some(1));
    assert_eq!(cand.episode_i64(), None, "pack persiste episódio nulo");
    assert_eq!(cand.probe_season_i64(), Some(1));
    assert_eq!(cand.probe_episode_i64(), Some(8), "sonda olha o EPISÓDIO");
    assert_eq!(cand.size_i64(), Some(75591424471));
    assert_eq!(cand.slot_limit_i64(), Some(2));
    assert_eq!(cand.added_at_i64(), Some(1769404800000));
    assert!(cand.is_pack());
    assert!(cand.is_rare());
}

/// Fixture mínimo do teste TS (`{ infoHash, title }`) + campos `null` sempre
/// gravados pelo `toQueueCandidate` (probeSeason/probeEpisode/episode).
#[test]
fn roundtrip_do_candidato_minimo_com_nulos_do_ts() {
    let fixture = r#"[{
        "probeSeason": null,
        "probeEpisode": null,
        "infoHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "title": "Reindex candidate",
        "episode": null
    }]"#;
    let parsed = candidates(fixture);
    assert_eq!(reserialize(&parsed), parse(fixture));

    assert_eq!(parsed[0].probe_season_i64(), None);
    assert_eq!(parsed[0].probe_episode_i64(), None);
}

#[test]
fn campos_desconhecidos_sobrevivem_como_o_spread_do_writequeue() {
    let fixture = r#"[{
        "probeSeason": null,
        "probeEpisode": null,
        "infoHash": "cccccccccccccccccccccccccccccccccccccccc",
        "episode": null,
        "custom": {"a": 1, "b": [true, null]},
        "_legado": "marca antiga"
    }]"#;
    let parsed = candidates(fixture);
    assert_eq!(reserialize(&parsed), parse(fixture));
}

#[test]
fn numero_fracionario_nao_condena_a_fila_e_preserva_a_forma() {
    // Um `size` fracionário (dado velho) não pode derrubar o parse da fila.
    let fixture = r#"[{
        "probeSeason": null,
        "probeEpisode": null,
        "infoHash": "dddddddddddddddddddddddddddddddddddddddd",
        "episode": null,
        "size": 1.5,
        "seeders": 1080
    }]"#;
    let parsed = candidates(fixture);
    assert_eq!(reserialize(&parsed), parse(fixture));
    assert_eq!(parsed[0].size_i64(), Some(1), "trunc como o JS");
    assert_eq!(parsed[0].seeders_i64(), Some(1080));
}

#[test]
fn write_queue_deduplica_primeiro_vence_e_limita_profundidade() {
    let q = queue_v3();
    let h1 = "a".repeat(40);
    let h2 = "b".repeat(40);
    let cands = candidates(&format!(
        r#"[
        {{"probeSeason": null, "probeEpisode": null, "infoHash": "{h1}", "episode": null, "title": "A", "addedAt": 100}},
        {{"probeSeason": null, "probeEpisode": null, "infoHash": "{h2}", "episode": null, "title": "B"}},
        {{"probeSeason": null, "probeEpisode": null, "infoHash": "{h1}", "episode": null, "title": "Duplicado"}},
        {{"probeSeason": null, "probeEpisode": null, "infoHash": "", "episode": null, "title": "Sem hash"}}
    ]"#
    ));
    let report = q
        .write_queue("streams:v6:movie:ttX", &cands, 3600, 2, None, 1_000)
        .unwrap();
    // Hash minúsculo vira chave do dedupe: "A"... minúsculo já; o vazio sai.
    assert_eq!(
        report.kept, 2,
        "dedupe primeiro-vence + teto de profundidade"
    );
    assert_eq!(
        report.dropped, 2,
        "sem hash e duplicado contam como descarte"
    );

    let read = q.read_queue("streams:v6:movie:ttX", 1_001).unwrap();
    assert_eq!(read.len(), 2);
    assert_eq!(read[0].hash(), h1);
    assert_eq!(
        read[0].added_at_i64(),
        Some(100),
        "addedAt presente é mantido"
    );
    assert_eq!(
        read[1].added_at_i64(),
        Some(1_000),
        "addedAt ausente nasce de now_ms"
    );
    assert_eq!(read[1].hash(), h2);
}

#[test]
fn write_queue_filtra_hash_morto_somente_no_escopo_da_conta() {
    let q = queue_v3();
    let adapter = "alldebrid";
    let account = "acc_dead";
    let dead_hash = "e".repeat(40);
    let live_hash = "f".repeat(40);
    q.mark_dead(adapter, account, &dead_hash, 86_400, 1_000)
        .unwrap();

    let cands = candidates(&format!(
        r#"[
        {{"probeSeason": null, "probeEpisode": null, "infoHash": "{dead_hash}", "episode": null}},
        {{"probeSeason": null, "probeEpisode": null, "infoHash": "{live_hash}", "episode": null}}
    ]"#
    ));

    // Sem adapter+conta: nada é filtrado (o chamador Node só filtra com os dois).
    let report = q
        .write_queue("streams:v6:movie:ttY", &cands, 3600, 8, None, 1_000)
        .unwrap();
    assert_eq!(report.kept, 2);

    // Com o escopo: o morto sai antes dos pools.
    let report = q
        .write_queue(
            "streams:v6:movie:ttZ",
            &cands,
            3600,
            8,
            Some((adapter, account)),
            1_001,
        )
        .unwrap();
    assert_eq!(report.kept, 1, "hash morto da conta sai");
    let read = q.read_queue("streams:v6:movie:ttZ", 1_002).unwrap();
    assert_eq!(read[0].hash(), live_hash);

    // Outra conta/adapter enxerga o hash vivo (escopo por adapter:conta).
    assert!(!q.is_dead(adapter, "outra", &dead_hash, 1_002).unwrap());
    assert!(!q.is_dead("torbox", account, &dead_hash, 1_002).unwrap());
    assert!(q
        .is_dead(adapter, account, &dead_hash.to_uppercase(), 1_002)
        .unwrap());
}

#[test]
fn write_queue_vazia_esquece_a_chave_e_fila_ausente_le_vazia() {
    let q = queue_v3();
    assert!(q
        .read_queue("streams:v6:movie:ttNone", 1_000)
        .unwrap()
        .is_empty());
    assert_eq!(q.totals(1_000).unwrap(), (0, 0));

    let h1 = "1".repeat(40);
    let cands = candidates(&format!(
        r#"[{{"probeSeason": null, "probeEpisode": null, "infoHash": "{h1}", "episode": null}}]"#
    ));
    let search_key = "streams:v6:movie:ttEmpty";
    q.write_queue(search_key, &cands, 3600, 8, None, 1_000)
        .unwrap();
    assert_eq!(q.totals(1_001).unwrap(), (1, 1));
    assert_eq!(q.queue_keys(1_001).unwrap(), vec![queue_key(search_key)]);

    // Gravar vazio esquece a chave (o caminho do purgeSeedsQueue).
    q.write_queue(search_key, &[], 3600, 8, None, 1_002)
        .unwrap();
    assert!(q.read_queue(search_key, 1_003).unwrap().is_empty());
    assert!(q.queue_keys(1_003).unwrap().is_empty());
}

#[test]
fn drop_queue_aceita_chave_pronta_ou_search_key() {
    let q = queue_v3();
    let h1 = "2".repeat(40);
    let cands = candidates(&format!(
        r#"[{{"probeSeason": null, "probeEpisode": null, "infoHash": "{h1}", "episode": null}}]"#
    ));
    let search_key = "streams:v6:movie:ttDrop";
    q.write_queue(search_key, &cands, 3600, 8, None, 1_000)
        .unwrap();

    assert!(
        q.drop_queue(&queue_key(search_key)).unwrap(),
        "chave pronta sai"
    );
    q.write_queue(search_key, &cands, 3600, 8, None, 1_001)
        .unwrap();
    assert!(
        q.drop_queue(search_key).unwrap(),
        "searchKey resolve a chave"
    );
    assert!(
        !q.drop_queue(search_key).unwrap(),
        "segunda passada nada a apagar"
    );
    assert!(!q.drop_queue("").unwrap(), "vazio é não-op, como no Node");
}

/// As três formas do marker do Node (`1`, `{id}`, `{id,…}`) convivem: os
/// leitores testam TRUTHINESS. O marker LEGADO não é elegível à evicção (sem
/// `obra` não há prova de identidade).
#[test]
fn marker_preserva_as_tres_formas_do_node() {
    let q = queue_v3();
    let adapter = "premiumize";
    let account = "acc_marker";
    let hash = "3".repeat(40);

    // Forma 1: legacy truthy.
    q.set_marker(adapter, account, &hash, &Value::from(1), 3_600, 1_000)
        .unwrap();
    assert_eq!(
        q.marker(adapter, account, &hash, 1_001).unwrap(),
        Some(json!(1))
    );

    // Forma 2: só o id da transferência.
    let with_id = marker_value(true, Some("tr-42"), None, 1_002);
    assert_eq!(with_id, json!({"id": "tr-42"}));
    q.set_marker(adapter, account, &hash, &with_id, 3_600, 1_002)
        .unwrap();
    assert_eq!(
        q.marker(adapter, account, &hash, 1_003).unwrap(),
        Some(json!({"id": "tr-42"}))
    );

    // Forma 3: meta completa (pool/obra/acceptedAt/title/br/dubbed).
    let meta = json!({
        "pool": "seeds",
        "obra": "sha256-da-obra",
        "acceptedAt": 1_770_000_000_000i64,
        "title": "Filme 2024 1080p DUBLADO",
        "br": true,
        "dubbed": true,
    });
    let full = marker_value(true, Some("tr-43"), Some(&meta), 1_004);
    q.set_marker(adapter, account, &hash, &full, 3_600, 1_004)
        .unwrap();
    let stored = q.marker(adapter, account, &hash, 1_005).unwrap().unwrap();
    assert_eq!(stored["pool"], "seeds");
    assert_eq!(stored["obra"], "sha256-da-obra");
    assert_eq!(stored["acceptedAt"], 1_770_000_000_000i64);
    assert_eq!(stored["br"], true);
    assert_eq!(stored["dubbed"], true);

    // Recusa não grava id; meta sem acceptedAt nasce do relógio entrado.
    assert_eq!(marker_value(false, Some("x"), None, 7_000), json!(1));
    let fresh = marker_value(true, Some("tr-44"), Some(&json!({"br": false})), 9_000);
    assert_eq!(fresh["acceptedAt"], 9_000);
    assert_eq!(fresh["br"], false, "br false explícito, como o TS grava");

    assert!(q.forget_marker(adapter, account, &hash).unwrap());
    assert_eq!(q.marker(adapter, account, &hash, 1_006).unwrap(), None);
}

/// Escrita CRUA no formato do Node (`JSON.stringify` na tabela `cache`): o que
/// o cache.set do Node grava, o crate lê. É a metade viva do round-trip — a
/// outra metade (crate grava, Node lê) é provada pela ponte napi no teste TS.
#[test]
fn fila_gravada_pelo_node_e_legivel_pelo_crate() {
    let q = queue_v3();
    let search_key = "streams:v5:series:tt0903747:1:1";
    // Simula exatamente o INSERT do cache-db do Node (value = JSON string).
    q.kv()
        .put_json(
            &queue_key(search_key),
            &parse(FIXTURE_PACK_TS),
            86_400,
            1_000,
        )
        .unwrap();

    let read = q.read_queue(search_key, 1_001).unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(
        read[0].name.as_deref(),
        Some("Lanterns S01 1080p WEB-DL DUAL")
    );
    // Reescrevendo pelo crate, o valor permanece semanticamente o mesmo.
    let report = q
        .write_queue(search_key, &read, 86_400, 8, None, 1_002)
        .unwrap();
    assert_eq!(report.kept, 1);
    let again = q
        .kv()
        .get_json(&queue_key(search_key), 1_003)
        .unwrap()
        .unwrap();
    assert_eq!(again, parse(FIXTURE_PACK_TS), "crate grava o que o Node lê");
}
