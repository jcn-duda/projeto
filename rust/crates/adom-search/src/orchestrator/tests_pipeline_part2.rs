//! Parte 2 dos testes de pipeline: corte externo com continuação em fundo,
//! fila tardia e efeitos de cauda (`EFFECTS_RUST`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::orchestrator::tests::test_support::*;

// ── Corte externo + continuação em fundo + fila tardia ─────────────────────

#[tokio::test]
async fn corte_de_prazo_parcial_continua_em_fundo_e_grava_no_store() {
    let now = 1_000_000;
    let mut config = config();
    // Prazo de resposta curtíssimo: a coleta (120ms) não cabe.
    config.stremio_reply_ms = 40;
    config.budgets.reply_deadline_ms = 40;
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::slow(vec![item(HASH)], Duration::from_millis(120));
    let tail = Arc::new(RecordingTail::default());
    let index = StubIndex::with(Vec::new());
    let orch = orchestrator(config, store.clone(), collector.clone(), &[HASH])
        .with_tail(tail.clone())
        .with_index_source(index.clone());
    let key = entry_key(&orch);

    let resposta = orch.handle(request(now)).await;
    assert_eq!(resposta.streams.len(), 1);
    assert_eq!(
        resposta.streams[0].name.as_deref(),
        Some(NOTICE_SEARCHING),
        "corte externo devolve o aviso"
    );
    assert_eq!(resposta.cache_max_age, 0);
    // A resposta saiu ANTES da coleta terminar: store vazio e fila tardia
    // ainda não disparou (nada de esperar o fundo dentro da resposta).
    assert!(store.get_with_stale(&key, 300, now as u64).is_none());
    assert!(index.recorded().is_empty(), "fila tardia fora da resposta");

    // O passe tardio termina em fundo e grava a lista COMPLETA.
    let mut entry = None;
    for _ in 0..80 {
        if let Some(hit) = store.get_with_stale(&key, 300, now as u64) {
            if !hit.value.streams.is_empty() {
                entry = Some(hit.value);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let entry = entry.expect("continuação em fundo precisa gravar no store");
    assert_eq!(entry.streams.len(), 1);
    assert!(!entry.partial, "coleta encerrada = entrada completa");
    assert_eq!(entry.debrid_known, Some(true));

    // Fila tardia: gravação no índice NATIVO DEPOIS da resposta.
    for _ in 0..80 {
        if !index.recorded().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let writes = index.recorded();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].imdb, "tt0133093");
    assert!(!writes[0].items.is_empty());
    assert_eq!(collector.calls(), 1);
}

// ── Efeitos de cauda (`EFFECTS_RUST`) ──────────────────────────────────────

/// Item BR dublado em cache: é o que o `applyDebrid` interroga/ esquenta.
fn item_br_dublado(hash: &str) -> RawItem {
    RawItem {
        title: Some("Filme Teste 2024 1080p WEB-DL DUBLADO".into()),
        info_hash: Some(hash.into()),
        seeders: Some(20.0),
        indexer: Some("bludv".into()),
        is_br: true,
        ..RawItem::default()
    }
}

/// Todos os efeitos de todos os lotes (o `season_key` sai num lote próprio).
fn efeitos_emitidos(tail: &RecordingTail) -> Vec<crate::internal_types::EffectEntry> {
    tail.effects_batches()
        .into_iter()
        .flat_map(|batch| batch.effects)
        .collect()
}

fn achar<'a>(
    effects: &'a [crate::internal_types::EffectEntry],
    kind: &str,
) -> Option<&'a crate::internal_types::EffectEntry> {
    effects.iter().find(|effect| effect.kind == kind)
}

#[tokio::test]
async fn effects_rust_off_nao_emite_efeitos_de_cauda() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::with(vec![item_br_dublado(HASH)]);
    let tail = Arc::new(RecordingTail::default());
    let index = StubIndex::with(Vec::new());
    let bank = StubBank::new(Vec::new(), std::collections::BTreeMap::new());
    let orch = orchestrator(config(), store, collector, &[HASH])
        .with_tail(tail.clone())
        .with_index_source(index.clone())
        .with_bank_source(bank.clone());
    assert!(!orch.config().effects_enabled);

    let _ = orch.handle(request(1_000_000)).await;
    tokio::time::sleep(Duration::from_millis(120)).await;
    let kinds: Vec<String> = tail
        .effects_batches()
        .into_iter()
        .flat_map(|batch| batch.effects)
        .map(|effect| effect.kind)
        .collect();
    assert!(
        kinds
            .iter()
            .all(|kind| kind == "harvester_enqueue" || kind == "br_probe"),
        "default OFF: só o follow-up do índice sai: {kinds:?}"
    );
    // A captura do banco VIVO deixou de ser efeito (T2-L1): nada de
    // `magnet_capture` no fio, mesmo com o banco ligado.
    assert!(
        !kinds.iter().any(|kind| kind == "magnet_capture"),
        "o efeito `magnet_capture` não existe mais: {kinds:?}"
    );
    // Mas ela TEM gate PRÓPRIO (`MAGNET_BANK`) e roda no processo: desligar os
    // efeitos de cauda não pode congelar o acervo que a coleta nativa viu.
    assert!(
        bank.captures() > 0,
        "a captura nativa do acervo rodou no tail"
    );
    // A gravação no índice NATIVO SEGUE rodando: só os efeitos são flagados.
    assert!(!index.recorded().is_empty());
}

#[tokio::test]
async fn effects_rust_on_emite_interrogatorio_e_warmer_no_tail() {
    const FRIO: &str = "9876543210fedcba9876543210fedcba98765432";
    let store = Arc::new(MemorySwrStore::new());
    // Um ⚡ (interrogatório) e um frio (warmer): os picks do warmer excluem o
    // que já está em cache, como no `applyDebrid`.
    let collector = StubCollector::with(vec![item_br_dublado(HASH), item_br_dublado(FRIO)]);
    let tail = Arc::new(RecordingTail::default());
    let mut cfg = config();
    cfg.effects_enabled = true;
    let orch = orchestrator(cfg, store, collector, &[HASH]).with_tail(tail.clone());

    let _ = orch.handle(request(1_000_000)).await;
    tokio::time::sleep(Duration::from_millis(120)).await;

    let effects = efeitos_emitidos(&tail);
    let audit = achar(&effects, "dub_audit").expect("dub_audit no lote");
    assert_eq!(audit.payload["adapter_id"], json!("alldebrid"));
    assert_eq!(audit.payload["api_key"], json!("chave-teste"));
    let candidates = audit.payload["candidates"].as_array().expect("array");
    assert!(
        candidates.iter().any(|c| c["hash"] == json!(HASH)),
        "o ⚡ dublado é interrogado: {candidates:?}"
    );
    let warmer = achar(&effects, "rd_warmer").expect("rd_warmer no lote");
    let releases = warmer.payload["releases"].as_array().expect("array");
    assert!(
        releases.iter().any(|r| r["infoHash"] == json!(FRIO)),
        "o frio é aquecido: {releases:?}"
    );
    assert!(
        !releases.iter().any(|r| r["infoHash"] == json!(HASH)),
        "hash em cache não entra no warmer"
    );
    assert_eq!(releases[0]["isBr"], json!(true));

    // O lote do Chupim leva o universo PÓS-CHECAGEM INTEIRO (o frio que o
    // cachedOnly esconde é justamente o alvo do download), com os fatos
    // internos e o `known` da checagem.
    let batch = achar(&effects, "autofetch_batch").expect("autofetch_batch no lote");
    assert_eq!(batch.payload["known"], json!(true));
    assert_eq!(batch.payload["imdbId"], json!("tt0133093"));
    let items = batch.payload["items"].as_array().expect("items array");
    let hashes: Vec<&str> = items
        .iter()
        .filter_map(|item| item["infoHash"].as_str())
        .collect();
    assert!(hashes.contains(&HASH), "item em cache no lote: {hashes:?}");
    assert!(
        hashes.contains(&FRIO),
        "o frio cortado pelo cachedOnly continua no lote: {hashes:?}"
    );
    let item = items
        .iter()
        .find(|item| item["infoHash"] == json!(HASH))
        .expect("item do HASH");
    assert_eq!(item["_br"], json!(true));
    // O título BR "DUBLADO" é promessa (`_dubClaim`); prova só com arquivo.
    assert!(
        item["_dubbed"] == json!(true) || item["_dubClaim"] == json!(true),
        "fato de áudio no lote: {item:?}"
    );
    assert_eq!(item["_quality"], json!("1080p"));
    let cached = batch.payload["cached"].as_array().expect("cached array");
    assert!(cached.iter().any(|h| h == &json!(HASH)));
}

#[tokio::test]
async fn effects_rust_on_emite_proximo_episodio_de_serie() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::with(vec![item_br_dublado(HASH)]);
    let tail = Arc::new(RecordingTail::default());
    let mut cfg = config();
    cfg.effects_enabled = true;
    let orch = orchestrator(cfg, store, collector, &[HASH])
        .with_tail(tail.clone())
        .with_meta(Arc::new(StubMeta(SearchMeta {
            season: Some(2),
            episode: Some(3),
            ..meta()
        })));

    let mut req = request(1_000_000);
    req.kind = "series".into();
    req.id = "tt0133093:2:3".into();
    let resposta = orch.handle(req).await;
    assert!(
        !resposta.streams.is_empty(),
        "precisa de play para enfileirar"
    );
    tokio::time::sleep(Duration::from_millis(120)).await;

    let effects = efeitos_emitidos(&tail);
    let next = achar(&effects, "harvester_enqueue").expect("harvester_enqueue");
    assert_eq!(next.payload["reason"], json!("next-episode"));
    assert_eq!(next.payload["season"], json!(2));
    assert_eq!(next.payload["episode"], json!(4));
    assert_eq!(next.payload["type"], json!("series"));
    // A chave da lista por temporada sai na abertura, como no `findStreams`.
    let key = achar(&effects, "season_key").expect("season_key");
    assert_eq!(key.payload["season"], json!(2));
    assert_eq!(key.payload["adapter_id"], json!("alldebrid"));
    assert_eq!(
        key.payload["account"],
        json!(adom_core::account_scope(&json!("chave-teste")))
    );
}
