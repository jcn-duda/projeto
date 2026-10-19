//! Orçamento F1: metadados × providers, graça BR e corte/continuação.
//!
//! Espelha o portável de `test/search-budget-metadata.test.ts`. Métricas
//! `search.deadline[.metadata|.providers]` e `search.first.*` NÃO estão portadas;
//! aqui fixamos a conta (relógio pós-metadados), o corte com continuação em fundo
//! e a graça BR ligada pelo `search.rs` real, via API pública (sem stubs internos).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use adom_search::orchestrator::{
    CollectBatch, CollectJob, Collector, MetaQuery, MetaSource, NoDebridFactory, Orchestrator,
    OrchestratorConfig, RouteFuture, SearchMeta, NOTICE_SEARCHING,
};
use adom_search::{
    reply_deadline_ms, request_cache_key, CollectBudgets, MemorySwrStore, RawItem, StreamRequest,
    StreamResponse, StreamsEntry, SwrStore,
};

const HASH: &str = "0123456789abcdef0123456789abcdef01234567";
const BR_HASH: &str = "89abcdef0123456789abcdef0123456789abcdef";

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn meta() -> SearchMeta {
    SearchMeta {
        imdb_id: "tt0133093".into(),
        name: "Filme Teste".into(),
        names: vec!["Filme Teste".into()],
        year: json!("2024"),
        query: "Filme Teste 2024".into(),
        ..SearchMeta::default()
    }
}

fn item(hash: &str, is_br: bool) -> RawItem {
    RawItem {
        title: Some(if is_br {
            "Filme Teste 2024 1080p DUBLADO".into()
        } else {
            "Filme Teste 2024 1080p WEB-DL x264".into()
        }),
        info_hash: Some(hash.into()),
        seeders: Some(20.0),
        is_br,
        ..RawItem::default()
    }
}

/// Base TS da graça BR: deadline 5000, reserve 4600 e `brPartialGrace` 1000.
fn config(
    reply_ms: u64,
    debrid_reserve_ms: i64,
    debrid_check_floor_ms: i64,
    br_partial_grace_ms: i64,
) -> OrchestratorConfig {
    OrchestratorConfig {
        stremio_reply_ms: reply_ms,
        app_reply_ms: reply_ms,
        budgets: CollectBudgets {
            reply_deadline_ms: reply_ms as i64,
            debrid_reserve_ms,
            debrid_check_floor_ms,
            br_partial_grace_ms,
            br_total_ms: 8000,
        },
        defaults: json!({
            "providers": ["jackett"],
            "debridService": "",
            "debridApiKey": "",
        }),
        sweep_enabled: false,
        trace_enabled: false,
        ..OrchestratorConfig::default()
    }
}

fn config_br(floor: i64) -> OrchestratorConfig {
    let mut cfg = config(5000, 4600, floor, 1000);
    cfg.selected_indexers = vec!["globaltest".into(), "brtest".into()];
    cfg.pt_br_indexers = vec!["brtest".into()];
    cfg
}

fn request(now: i64) -> StreamRequest {
    StreamRequest {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: None,
        user_agent: Some("Stremio/1.6".into()),
        origin: Some("http://127.0.0.1:7000".into()),
        now_ms: Some(now),
    }
}

/// Mesma chave que `Orchestrator::handle` monta (defaults + `resolveUncached`).
fn cache_key(config: &OrchestratorConfig) -> String {
    let mut opts = config.defaults.clone();
    opts.as_object_mut()
        .expect("opções são objeto")
        .insert("resolveUncached".into(), Value::Bool(false));
    request_cache_key("movie", "tt0133093", &opts)
}

fn has_notice(response: &StreamResponse) -> bool {
    response
        .streams
        .iter()
        .any(|s| s.name.as_deref() == Some(NOTICE_SEARCHING))
}

fn has_hash(streams: &[adom_search::StreamItem], hash: &str) -> bool {
    streams.iter().any(|s| s.info_hash.as_deref() == Some(hash))
}

/// Espera o store receber `min` streams, com prazo de teste próprio.
async fn wait_streams(store: &MemorySwrStore, key: &str, min: usize) -> StreamsEntry {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(hit) = store.get_with_stale(key, 300, now_epoch() as u64) {
            if hit.value.streams.len() >= min {
                return hit.value;
            }
        }
        assert!(
            Instant::now() < deadline,
            "store não recebeu {min} stream(s)"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

struct DelayMeta {
    delay: Duration,
    meta: SearchMeta,
}

impl DelayMeta {
    fn new(delay_ms: u64) -> Self {
        DelayMeta {
            delay: Duration::from_millis(delay_ms),
            meta: meta(),
        }
    }
}

impl MetaSource for DelayMeta {
    fn resolve<'a>(&'a self, _req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        let delay = self.delay;
        let meta = self.meta.clone();
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            Ok(meta)
        })
    }
}

struct DelayCollector {
    delay: Duration,
    items: Vec<RawItem>,
}

impl DelayCollector {
    fn new(delay_ms: u64, items: Vec<RawItem>) -> Self {
        DelayCollector {
            delay: Duration::from_millis(delay_ms),
            items,
        }
    }
}

impl Collector for DelayCollector {
    fn collect<'a>(
        &'a self,
        _job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        let delay = self.delay;
        let items = self.items.clone();
        Box::pin(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            Ok(CollectBatch {
                items,
                partial: false,
                ..Default::default()
            })
        })
    }
}

/// Global imediato + BR prioritário atrasado: é a tarefa `Priority` do `search.rs`.
struct BrJobCollector {
    release_ms: u64,
}

impl Collector for BrJobCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        let is_priority = job.priority;
        let release_ms = if is_priority { self.release_ms } else { 0 };
        Box::pin(async move {
            if release_ms > 0 {
                tokio::time::sleep(Duration::from_millis(release_ms)).await;
            }
            let raw = if is_priority {
                item(BR_HASH, true)
            } else {
                item(HASH, false)
            };
            Ok(CollectBatch {
                items: vec![raw],
                partial: false,
                ..Default::default()
            })
        })
    }
}

// ── Conta do orçamento: metadados consomem a janela do provider ─────────────

#[test]
fn metadata_consome_o_orcamento_do_provider_e_o_piso_e_500ms() {
    let budgets = CollectBudgets {
        reply_deadline_ms: 9200,
        debrid_reserve_ms: 4500,
        ..CollectBudgets::default()
    };
    let start = 1_000_000;
    let deadline = Some(start + 9200);

    // Antes: prazo - reserva. Após 2500ms de metadados: só o que sobrou.
    assert_eq!(budgets.collection_budget(deadline, start), 4700);
    assert_eq!(budgets.collection_budget(deadline, start + 2500), 2200);
    // Metadados de 5000ms corroem até o piso; prazo vencido também cai nele.
    assert_eq!(budgets.collection_budget(deadline, start + 5000), 500);
    assert_eq!(budgets.collection_budget(deadline, start + 9201), 500);
}

#[test]
fn orcamento_do_app_dart_e_maior_que_o_do_stremio() {
    let stremio = reply_deadline_ms(Some("Stremio/1.6"), 9200, 15_000);
    let dart = reply_deadline_ms(Some("Dart/3.4 (dart:io)"), 9200, 15_000);
    assert_eq!(stremio, 9200);
    assert_eq!(dart, 15_000);

    let now = 1_000_000;
    let stremio_budgets = CollectBudgets {
        reply_deadline_ms: stremio as i64,
        debrid_reserve_ms: 4500,
        ..CollectBudgets::default()
    };
    let dart_budgets = CollectBudgets {
        reply_deadline_ms: dart as i64,
        ..stremio_budgets.clone()
    };
    assert_eq!(
        stremio_budgets.collection_budget(Some(now + stremio as i64), now),
        4700
    );
    assert_eq!(
        dart_budgets.collection_budget(Some(now + dart as i64), now),
        10_500,
        "o app Power Movie espera mais e por isso libera mais coleta"
    );
}

// ── Metadados lentos × coleta: corte e continuação ──────────────────────────

#[tokio::test]
async fn metadata_lento_com_provider_rapido_nao_vira_corte() {
    let now = now_epoch();
    let cfg = config(800, 100, 100, 1500);
    let store = Arc::new(MemorySwrStore::new());
    let collector = Arc::new(DelayCollector::new(0, vec![item(HASH, false)]));
    let orch = Orchestrator::new(cfg, store)
        .with_meta(Arc::new(DelayMeta::new(200)))
        .with_collector(collector)
        .with_debrid(Arc::new(NoDebridFactory));

    let started = Instant::now();
    let response = orch.handle(request(now)).await;

    assert!(
        started.elapsed() >= Duration::from_millis(190),
        "metadados custaram ~200ms e entram no tempo da resposta"
    );
    assert!(
        !has_notice(&response),
        "provider rápido não pode virar aviso"
    );
    assert_eq!(response.streams.len(), 1);
    assert_eq!(response.streams[0].info_hash.as_deref(), Some(HASH));
    assert_eq!(response.cache_max_age, 900);
}

#[tokio::test]
async fn metadata_consome_janela_do_provider_e_corta_antes_do_deadline_externo() {
    let now = now_epoch();
    // Sem metadados: 2500-1500=1000ms e o provider (600ms) caberia. Com 700ms:
    // (1800-1500)=300 → piso 500ms; perde a janela antes do deadline de 2500ms.
    let reply_ms = 2500;
    let cfg = config(reply_ms, 1500, 100, 1500);
    let key = cache_key(&cfg);
    let store = Arc::new(MemorySwrStore::new());
    let collector = Arc::new(DelayCollector::new(600, vec![item(HASH, false)]));
    let orch = Orchestrator::new(cfg, store.clone())
        .with_meta(Arc::new(DelayMeta::new(700)))
        .with_collector(collector)
        .with_debrid(Arc::new(NoDebridFactory));

    let started = Instant::now();
    let response = orch.handle(request(now)).await;
    let elapsed = started.elapsed();

    assert!(
        has_notice(&response),
        "janela parcial vazia devolve 'reabra'"
    );
    assert_eq!(response.cache_max_age, 0);
    assert!(
        elapsed >= Duration::from_millis(1150) && elapsed < Duration::from_millis(reply_ms),
        "saiu em ~700ms de metadata + 500ms de janela, antes do deadline de {reply_ms}ms: {elapsed:?}"
    );
    // A task não é cancelada: o passe tardio grava a lista completa no store (§6).
    let entry = wait_streams(&store, &key, 1).await;
    assert_eq!(entry.streams.len(), 1);
    assert!(!entry.partial, "coleta encerrada = entrada completa");
}

// ── Graça BR: integração com o `search.rs` real (Priority de plan_jobs) ─────

/// Piso do debrid varia; release_offset é relativo ao orçamento. Devolve 1ª/BR final.
async fn br_first_response(floor: i64, release_offset_ms: i64) -> (bool, i64, i64, bool) {
    let now = now_epoch();
    let cfg = config_br(floor);
    let budgets = cfg.budgets.clone();
    let budget = budgets.collection_budget(Some(now + cfg.stremio_reply_ms as i64), now);
    let grace = budgets.priority_grace();
    let release_ms = (budget + release_offset_ms).max(0) as u64;
    let key = cache_key(&cfg);
    let store = Arc::new(MemorySwrStore::new());
    let orch = Orchestrator::new(cfg, store.clone())
        .with_meta(Arc::new(DelayMeta::new(0)))
        .with_collector(Arc::new(BrJobCollector { release_ms }))
        .with_debrid(Arc::new(NoDebridFactory));

    let response = orch.handle(request(now)).await;
    let first = has_hash(&response.streams, BR_HASH);
    let entry = wait_streams(&store, &key, 2).await;
    let after = has_hash(&entry.streams, BR_HASH);
    (first, budget, grace, after)
}

#[tokio::test]
async fn graca_br_encaixa_fonte_dentro_do_orcamento() {
    // Graça 0 (floor == reserve) e BR liberada ANTES do orçamento → entra.
    let (first, budget, grace, after) = br_first_response(4600, -300).await;
    assert_eq!(grace, 0, "reserve == floor zera a graça");
    assert_eq!(budget, 500);
    assert!(first, "a fonte dentro do orçamento entra na 1ª resposta");
    assert!(after, "o completion também carrega a BR");
}

#[tokio::test]
async fn graca_br_encaixa_fonte_atrasada_quando_a_janela_e_positiva() {
    // floor 400 → graça = min(1000, 4600-400) = 1000ms; BR a budget+200.
    let (first, budget, grace, after) = br_first_response(400, 200).await;
    assert_eq!(budget, 500);
    assert_eq!(grace, 1000);
    assert!(
        first,
        "regressão em search.rs priority_grace_ms=0 deixaria a BR fora da 1ª resposta"
    );
    assert!(after);
}

#[tokio::test]
async fn sem_graca_a_fonte_br_atrasada_fica_fora_da_primeira_resposta() {
    // Mesmo instante do caso anterior (budget + 200), mas floor == reserve.
    let (first, budget, grace, after) = br_first_response(4600, 200).await;
    assert_eq!(budget, 500);
    assert_eq!(grace, 0);
    assert!(!first, "sem janela, a BR atrasada não entra na resposta");
    assert!(
        after,
        "a BR continua no completion mesmo fora da 1ª resposta"
    );
}
