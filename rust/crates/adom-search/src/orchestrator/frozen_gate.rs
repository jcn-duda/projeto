//! Gate de paridade CONGELADA do `/stream` (Fase 1, `docs/stream-frozen-gate.md`).
//!
//! Lê `rust/golden/stream-frozen/<caso>/` e monta o orquestrador REAL com as
//! rotas internas substituídas pela captura: `FrozenRoutes` (meta/collect/index/
//! fallback) e `FrozenDebridFactory` (veredito de cache por hash). Nenhuma rede,
//! nenhum SQLite, nenhum relógio de parede.
//!
//! O alvo é `expected/node-response.json`, produzido pelo Node a partir das
//! MESMAS entradas. Diferença aqui é divergência de pipeline; ruído de coleta
//! ficou de fora por construção.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use adom_core::StreamDisplayConfig;

use crate::internal_types::{
    CollectRequest, CollectResponse, EffectsRequest, EffectsResponse, IndexWriteRequest,
    IndexWriteResponse, MetaRequest, MetaResponse, SearchIndexRequest, SearchIndexResponse,
};
use crate::list_builder::{BuildOptions, DebridAnswer, DebridCheck};
use crate::orchestrator::collect::NodeCollector;
use crate::orchestrator::config::{
    build_options_from, DebridContext, DebridFactory, OrchestratorConfig,
};
use crate::orchestrator::internal_routes::{InternalRoutes, RouteFuture};
use crate::orchestrator::meta::NodeMetaSource;
use crate::orchestrator::respond::StreamRequest;
use crate::orchestrator::tail::NoopTailEffects;
use crate::orchestrator::Orchestrator;
use crate::MemorySwrStore;
use adom_core::RankingStream;

// ── captura ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RequestFile {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    stream_id: String,
    #[serde(default)]
    encoded_len: usize,
}

#[derive(Debug, Deserialize)]
struct KeyFile {
    #[serde(default)]
    scope: String,
    #[serde(default)]
    season: Option<i64>,
    #[serde(default)]
    episode: Option<i64>,
    #[allow(dead_code)]
    #[serde(default)]
    query: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct BatchFile {
    #[serde(default)]
    items: Vec<Value>,
    #[serde(default)]
    partial: bool,
    #[serde(default)]
    live: Option<crate::internal_types::LiveSnapshot>,
}

#[derive(Debug, Deserialize)]
struct CollectFile {
    key: KeyFile,
    response: BatchFile,
}

#[derive(Debug, Deserialize)]
struct IndexFile {
    value: IndexValue,
}

#[derive(Debug, Deserialize)]
struct IndexValue {
    #[serde(rename = "servedFromIndex", default)]
    served_from_index: bool,
    #[serde(default)]
    instant: bool,
    #[serde(default)]
    raw: Option<BatchFile>,
}

#[derive(Debug, Deserialize, Default)]
struct DebridFile {
    #[serde(default)]
    calls: Vec<DebridCall>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DebridCall {
    #[allow(dead_code)]
    #[serde(default)]
    hashes: Vec<String>,
    #[serde(default)]
    known: bool,
    #[serde(default)]
    unusable: Option<Value>,
    #[serde(default)]
    cached: Vec<String>,
}

struct FrozenCase {
    request: RequestFile,
    meta: MetaResponse,
    collect: Vec<CollectFile>,
    index: SearchIndexResponse,
    debrid: DebridCall,
    /// Conjunto `instant` exato do sort (quando o record o capturou).
    instant: Vec<String>,
    options: Value,
    operator: Value,
}

impl FrozenCase {
    fn load(dir: &Path) -> Result<Self, String> {
        let request: RequestFile = read_json(&dir.join("request.json"))?;
        let meta_file: Value = read_json(&dir.join("inputs/meta.json"))?;
        let id = if request.stream_id.is_empty() {
            meta_file
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        } else {
            request.stream_id.clone()
        };
        // O id do Stremio de série é `tt…:S:E`; o `MetaResponse` do Node leva o
        // IMDb BASE + temporada/episódio separados. Usar o id completo fazia a
        // dica `w` do `/resolve` sair com `tt…:1:1` e divergia em toda série.
        let mut id_parts = id.split(':');
        let imdb_id = id_parts.next().unwrap_or(&id).to_string();
        let season = id_parts.next().and_then(|value| value.parse::<i64>().ok());
        let episode = id_parts.next().and_then(|value| value.parse::<i64>().ok());
        let meta = MetaResponse {
            ok: true,
            media_type: request.r#type.clone(),
            id: imdb_id.clone(),
            imdb_id: imdb_id.clone(),
            season,
            episode,
            meta: meta_file.get("meta").cloned(),
            titles: meta_file.get("titles").cloned(),
            multi_work: meta_file
                .get("collection")
                .cloned()
                .filter(|value| !value.is_null()),
            home_release_at: meta_file.get("homeReleaseAt").and_then(Value::as_i64),
        };
        let collect: Vec<CollectFile> = read_optional(&dir.join("inputs/collect.json"))?;
        let index_value: Option<IndexFile> = read_optional(&dir.join("inputs/index.json"))?;
        let index = index_value
            .map(|file| {
                let raw = file.value.raw.unwrap_or_default();
                SearchIndexResponse {
                    ok: true,
                    is_partial: raw.partial,
                    index_covered: file.value.served_from_index,
                    instant_eligible: file.value.instant,
                    index_items: raw.items,
                    instant_items: Vec::new(),
                    account_items: Vec::new(),
                }
            })
            .unwrap_or_default();
        let debrid: DebridFile = read_optional(&dir.join("inputs/debrid.json"))?;
        // Conjunto `instant` real do sort; ausente em capturas antigas → cai no
        // recorte de `fromAccount` (aproximação).
        let instant: Vec<String> = read_optional(&dir.join("inputs/instant.json"))?;
        let config: Value = read_json(&dir.join("inputs/config.json"))?;
        Ok(FrozenCase {
            request,
            meta,
            collect,
            index,
            debrid: debrid.calls.into_iter().next().unwrap_or_default(),
            instant,
            options: config.get("options").cloned().unwrap_or(Value::Null),
            operator: config.get("operator").cloned().unwrap_or(Value::Null),
        })
    }

    /// Hashes do inventário da conta (itens `fromAccount` da captura). É a
    /// evidência `instant` que o Node usa no sorteio (inventário pronto/alive).
    fn instant_hashes(&self) -> Vec<String> {
        let mut set = BTreeSet::new();
        for entry in &self.collect {
            for item in &entry.response.items {
                if !item
                    .get("fromAccount")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    continue;
                }
                let hash = item
                    .get("infoHash")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("magnet").and_then(Value::as_str))
                    .map(|raw| {
                        adom_core::extract_info_hash(raw)
                            .unwrap_or_default()
                            .trim()
                            .to_ascii_lowercase()
                    })
                    .unwrap_or_default();
                if !hash.is_empty() {
                    set.insert(hash);
                }
            }
        }
        set.into_iter().collect()
    }

    #[allow(clippy::field_reassign_with_default)] // harness de teste: espelha o config do operador campo a campo
    fn config(&self) -> OrchestratorConfig {
        let op = &self.operator;
        // O Node usa o inventário da conta como `instant` no sorteio. Sem a
        // chave, o desempate cai para seeders e troca itens do mesmo balde
        // (medido: Cidade de Deus, 720p global). `debridApiKey` sintética só
        // ativa o contexto: a checagem vem congelada, nunca da rede.
        let mut options = self.options.clone();
        if let Some(map) = options.as_object_mut() {
            map.insert("debridApiKey".into(), Value::String("frozen".into()));
            map.insert(
                "instantHashes".into(),
                Value::Array(
                    (if self.instant.is_empty() {
                        self.instant_hashes()
                    } else {
                        self.instant.clone()
                    })
                    .into_iter()
                    .map(Value::String)
                    .collect(),
                ),
            );
        }
        let mut config = OrchestratorConfig::default();
        config.defaults = options.clone();
        config.stremio_reply_ms = u64_of(&op["replyDeadline"], 9200);
        config.app_reply_ms = u64_of(&op["appReplyDeadline"], 15_000);
        config.cache_ttl = i64_of(&op["cacheTtl"], 900);
        config.fallback_streams_ttl = i64_of(&op["fallbackStreamsTtl"], 120);
        config.stale_grace_seconds = u64_of(&op["streamStaleGrace"], 300);
        config.resolve_uncached = bool_of(&op["resolveUncached"], false);
        config.build = build_options_from(&options, &BuildOptions::default());
        config.build.br_reserved_per_quality = f64_of(&op["search"]["brReservedPerQuality"], 1.0);
        config.build.candidate_pool_factor = f64_of(&op["search"]["candidatePoolFactor"], 4.0);
        config.build.notice_stream = bool_of(&op["search"]["noticeStream"], true);
        config.build.unaired_margin_ms = i64_of(&op["search"]["unairedMarginMs"], 86_400_000);
        config.build.pre_air_margin_ms =
            i64_of(&op["search"]["preAirReleaseMarginMs"], 172_800_000);
        config.build.pre_home_release_cut = bool_of(&op["search"]["preHomeReleaseCut"], true);
        config.build.pre_home_release_margin_ms =
            i64_of(&op["search"]["preHomeReleaseMarginMs"], 172_800_000);
        config.build.title_precision_tail_cut =
            bool_of(&op["search"]["titlePrecisionTailCut"], true);
        config.selected_indexers = string_list(&self.options["jackettIndexers"]);
        config.pt_br_indexers = string_list(&op["jackett"]["ptBr"]);
        config.isolate_indexers = string_list(&op["jackett"]["slow"]);
        config.index_only_indexers = string_list(&op["jackett"]["indexOnly"]);
        config.sweep_enabled = bool_of(&op["jackett"]["sweepEnabled"], true);
        config.search_index_rescue_min_ms = i64_of(&op["search"]["indexRescueMinMs"], 2500);
        config.trace_enabled = false;
        config.pack_tail = false;
        config.budgets.debrid_reserve_ms = i64_of(&op["budgets"]["debridReserveMs"], 4500);
        config.budgets.debrid_check_floor_ms = i64_of(&op["budgets"]["debridCheckFloorMs"], 1500);
        config.budgets.br_partial_grace_ms = i64_of(&op["budgets"]["brPartialGraceMs"], 1500);
        config.budgets.br_total_ms = i64_of(&op["budgets"]["searchTimeoutMs"], 8000);
        config.display = StreamDisplayConfig {
            stream_name_style: match op["display"]["style"].as_str() {
                Some("full") => adom_core::StreamNameStyle::Full,
                _ => adom_core::StreamNameStyle::Compact,
            },
            stream_name_show_source: bool_of(&op["display"]["showSource"], true),
        };
        // `reply_deadline_ms` do orquestrador é recomposto por cliente; o
        // valor do operador já está em `stremio_reply_ms`/`app_reply_ms`.
        config.budgets.reply_deadline_ms = config.stremio_reply_ms as i64;
        config
    }

    fn routes(self) -> FrozenRoutes {
        FrozenRoutes {
            meta: self.meta,
            collect: self.collect,
            index: self.index,
            pt_br: string_list(&self.operator["jackett"]["ptBr"]),
        }
    }

    fn debrid(&self) -> FrozenDebridFactory {
        FrozenDebridFactory {
            call: self.debrid.clone(),
        }
    }
}

// ── rotas congeladas ────────────────────────────────────────────────────────

struct FrozenRoutes {
    meta: MetaResponse,
    collect: Vec<CollectFile>,
    index: SearchIndexResponse,
    pt_br: Vec<String>,
}

impl FrozenRoutes {
    fn batch(&self, scope: &str, season: Option<i64>, episode: Option<i64>) -> BatchFile {
        if let Some(entry) = self.collect.iter().find(|entry| {
            entry.key.scope == scope && entry.key.season == season && entry.key.episode == episode
        }) {
            return BatchFile {
                items: entry.response.items.clone(),
                partial: entry.response.partial,
                live: entry.response.live.clone(),
            };
        }
        // O Node faz UMA coleta `all` (o collectRaw interno separa os grupos).
        // O plano Rust pede `priority`/`nonpriority`: particiona o mesmo lote
        // pela lista pt-BR, exatamente como o `plan_jackett_queries` faria.
        let Some(all) = self.collect.iter().find(|entry| entry.key.scope == "all") else {
            return BatchFile::default();
        };
        let is_br = |item: &Value| {
            let indexer = item.get("indexer").and_then(Value::as_str).unwrap_or("");
            self.pt_br.iter().any(|id| id == indexer)
        };
        let items = all
            .response
            .items
            .iter()
            .filter(|item| match scope {
                "priority" => is_br(item),
                "nonpriority" => !is_br(item),
                _ => true,
            })
            .cloned()
            .collect();
        BatchFile {
            items,
            partial: all.response.partial,
            live: all.response.live.clone(),
        }
    }
}

impl InternalRoutes for FrozenRoutes {
    fn meta<'a>(&'a self, _req: MetaRequest) -> RouteFuture<'a, MetaResponse> {
        Box::pin(async move { Ok(self.meta.clone()) })
    }

    fn collect<'a>(&'a self, req: CollectRequest) -> RouteFuture<'a, CollectResponse> {
        Box::pin(async move {
            let scope = req
                .task_scope
                .map(|scope| match scope {
                    crate::internal_types::TaskScope::All => "all",
                    crate::internal_types::TaskScope::Priority => "priority",
                    crate::internal_types::TaskScope::Nonpriority => "nonpriority",
                })
                .unwrap_or("all");
            let mut by_indexer: BTreeMap<String, Vec<Value>> = BTreeMap::new();
            let batch = self.batch(scope, req.season, req.episode);
            for item in &batch.items {
                let indexer = item
                    .get("indexer")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                by_indexer.entry(indexer).or_default().push(item.clone());
            }
            Ok(CollectResponse {
                ok: true,
                task_scope: scope.to_string(),
                query: req.query,
                imdb_id: req.imdb,
                season: req.season,
                episode: req.episode,
                partial: batch.partial,
                items: batch.items,
                by_indexer,
                live: batch.live,
                breaker: BTreeMap::new(),
                eligible: true,
            })
        })
    }

    fn index_write<'a>(&'a self, _req: IndexWriteRequest) -> RouteFuture<'a, IndexWriteResponse> {
        Box::pin(async {
            Ok(IndexWriteResponse {
                ok: true,
                recorded: 0,
                entries: 0,
                bank_marked: 0,
                failed: 0,
            })
        })
    }

    fn effects<'a>(&'a self, _req: EffectsRequest) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async {
            Ok(EffectsResponse {
                ok: true,
                accepted: 0,
                rejected: 0,
            })
        })
    }

    fn search_index<'a>(
        &'a self,
        _req: SearchIndexRequest,
    ) -> RouteFuture<'a, SearchIndexResponse> {
        Box::pin(async move { Ok(self.index.clone()) })
    }
}

// ── debrid congelado ────────────────────────────────────────────────────────

struct FrozenDebridFactory {
    call: DebridCall,
}

impl DebridFactory for FrozenDebridFactory {
    fn make(&self, _ctx: &DebridContext) -> Box<dyn DebridCheck + Send> {
        Box::new(FrozenDebridCheck {
            call: self.call.clone(),
            cached: self.call.cached.iter().cloned().collect(),
        })
    }
}

struct FrozenDebridCheck {
    call: DebridCall,
    cached: BTreeSet<String>,
}

impl DebridCheck for FrozenDebridCheck {
    fn check(&mut self, stream: &RankingStream) -> DebridAnswer {
        if self.call.unusable.is_some() {
            return DebridAnswer::Unusable;
        }
        if !self.call.known {
            return DebridAnswer::Unknown;
        }
        let hash = stream
            .info_hash
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase();
        if self.cached.contains(&hash) {
            DebridAnswer::Cached { url: None }
        } else {
            DebridAnswer::Missing
        }
    }
}

// ── porta pública do gate ───────────────────────────────────────────────────
//
// O módulo é exposto (`orchestrator::frozen_gate`) porque o alvo de integração
// `tests/stream_frozen_parity.rs` — o comando do gate — chama de fora do crate;
// `cfg(test)`/feature flag não servem (o comando é sem features e o alvo de
// integração é outro crate). A montagem segue privada: só estas três funções
// são públicas.

/// Raiz da captura: `rust/golden/stream-frozen` (mesma âncora de
/// `tests/stream_e2e_parity.rs`).
pub fn corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden/stream-frozen")
}

/// Casos do gate: diretórios com `request.json`, em ordem estável.
///
/// Não existe caminho "sem captura": raiz ausente ou vazia é ERRO. O teste
/// inline antigo retornava cedo quando o diretório faltava, o que deixava o
/// gate verde sem ter comparado nada — justamente o que o alvo novo não pode
/// fazer.
pub fn case_dirs() -> Result<Vec<PathBuf>, String> {
    let root = corpus_root();
    if !root.is_dir() {
        return Err(format!(
            "captura congelada ausente: {} não existe (o gate exige <caso>/request.json)",
            root.display()
        ));
    }
    let mut cases: Vec<PathBuf> = std::fs::read_dir(&root)
        .map_err(|err| format!("ler {}: {err}", root.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("request.json").is_file())
        .collect();
    cases.sort();
    if cases.is_empty() {
        return Err(format!(
            "captura congelada vazia: nenhum <caso>/request.json em {}",
            root.display()
        ));
    }
    Ok(cases)
}

/// Roda TODOS os casos e devolve, de uma vez, o diff legível de cada falha.
pub async fn run_all() -> Result<(), String> {
    let cases = case_dirs()?;
    let mut failures = Vec::new();
    for dir in cases {
        if let Err(err) = run_case(&dir).await {
            failures.push(format!("{}: {err}", dir.display()));
        }
    }
    if failures.is_empty() {
        return Ok(());
    }
    Err(format!(
        "paridade congelada falhou em {} caso(s):\n\n{}",
        failures.len(),
        failures.join("\n\n")
    ))
}

async fn run_case(dir: &Path) -> Result<(), String> {
    let frozen = FrozenCase::load(dir)?;
    let encoded = if frozen.request.encoded_len == 0 {
        None
    } else {
        Some("e30".to_string())
    };
    let kind = if frozen.request.r#type.is_empty() {
        "movie".to_string()
    } else {
        frozen.request.r#type.clone()
    };
    let id = frozen.request.stream_id.clone();
    let config = frozen.config();
    let debrid = frozen.debrid();
    let routes: Arc<dyn InternalRoutes> = Arc::new(frozen.routes());
    let orchestrator = Orchestrator::new(config, Arc::new(MemorySwrStore::new()))
        .with_meta(Arc::new(NodeMetaSource::new(routes.clone())))
        .with_collector(Arc::new(
            NodeCollector::new(routes.clone()).with_skip_account(true),
        ))
        .with_internal_routes(routes)
        .with_debrid(Arc::new(debrid))
        .with_tail(Arc::new(NoopTailEffects));
    let request = StreamRequest {
        kind,
        id,
        encoded: encoded.clone(),
        user_agent: Some("Dart/3.0 (dart:io)".to_string()),
        origin: Some("http://127.0.0.1:7200".to_string()),
        now_ms: Some(1_760_000_000_000),
    };
    let response = orchestrator.handle(request).await;
    let got = serde_json::to_value(&response).map_err(|err| err.to_string())?;
    let expected: Value = read_json(&dir.join("expected/node-response.json"))?;
    compare(
        &got,
        &expected,
        "http://127.0.0.1:7200",
        encoded.as_deref().unwrap_or(""),
    )?;
    // Evidência do que foi comparado: sucesso silencioso esconderia um gate que
    // não olhou nada (o defeito do teste inline que este alvo substituiu).
    println!(
        "[frozen] {}: {} stream(s), cacheMaxAge={} — igual ao Node",
        dir.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        got.get("streams")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        got.get("cacheMaxAge").cloned().unwrap_or(Value::Null),
    );
    Ok(())
}

fn compare(got: &Value, expected: &Value, origin: &str, encoded: &str) -> Result<(), String> {
    let got = normalize(got, origin, encoded);
    let expected = normalize(expected, origin, encoded);
    if got == expected {
        return Ok(());
    }
    let got_streams = got
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let want_streams = expected
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut lines = vec![format!(
        "total got={} want={}; cacheMaxAge got={} want={}",
        got_streams.len(),
        want_streams.len(),
        got.get("cacheMaxAge").cloned().unwrap_or(Value::Null),
        expected.get("cacheMaxAge").cloned().unwrap_or(Value::Null),
    )];
    for (index, want) in want_streams.iter().enumerate() {
        let have = got_streams.get(index);
        if have == Some(want) {
            continue;
        }
        lines.push(format!(
            "#{index} want={} got={}",
            short(want),
            have.map(short).unwrap_or_else(|| "<ausente>".to_string())
        ));
        if let Some(have) = have {
            lines.push(format!("  want_json={want}"));
            lines.push(format!("  got_json ={have}"));
        }
    }
    for (index, have) in got_streams.iter().enumerate().skip(want_streams.len()) {
        lines.push(format!("#{index} extra got={}", short(have)));
    }
    Err(lines.join("\n"))
}

fn normalize(value: &Value, origin: &str, encoded: &str) -> Value {
    let mut out = value.clone();
    if let Some(object) = out.as_object_mut() {
        if let Some(Value::Array(streams)) = object.get_mut("streams") {
            for stream in streams.iter_mut() {
                mask(stream, origin, encoded);
                if let Some(sources) = stream.get_mut("sources").and_then(Value::as_array_mut) {
                    sources.sort_by_key(|value| value.as_str().unwrap_or("").to_string());
                }
            }
            streams.sort_by_key(stream_key);
        }
    }
    out
}

fn stream_key(value: &Value) -> String {
    for field in ["infoHash", "url", "externalUrl", "name"] {
        if let Some(text) = value.get(field).and_then(Value::as_str) {
            return format!("{field}:{text}");
        }
    }
    String::new()
}

fn mask(value: &mut Value, origin: &str, encoded: &str) {
    match value {
        Value::String(text) => *text = mask_text(text, origin, encoded),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| mask(item, origin, encoded)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|item| mask(item, origin, encoded)),
        _ => {}
    }
}

/// O corpus é gravado mascarado (`{{base}}/{{config}}`), mas o Rust monta a URL
/// com o origin/encoded do replay; normaliza os dois lados antes do diff.
fn mask_text(text: &str, origin: &str, encoded: &str) -> String {
    let mut out = text.to_string();
    if !origin.is_empty() {
        out = out.replace(origin, "{{base}}");
    }
    if !encoded.is_empty() {
        out = out.replace(&format!("/{encoded}/"), "/{{config}}/");
    }
    let mut masked = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(index) = rest.find("sig=") {
        masked.push_str(&rest[..index + 4]);
        masked.push_str("{{sig}}");
        let after = &rest[index + 4..];
        let end = after
            .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'))
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    masked.push_str(rest);
    // O corpus gravou `sig={{sig}}` e o envelope mascara de novo; idempotência
    // vale para os dois lados do diff.
    masked.replace("{{sig}}{{sig}}", "{{sig}}")
}

fn short(value: &Value) -> String {
    let hash = value
        .get("infoHash")
        .and_then(Value::as_str)
        .map(|text| &text[..text.len().min(10)])
        .unwrap_or("-");
    let name = value.get("name").and_then(Value::as_str).unwrap_or("-");
    format!("{hash} | {name}")
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let bytes = std::fs::read(path).map_err(|err| format!("{}: {err}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|err| format!("{}: {err}", path.display()))
}

fn read_optional<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T, String> {
    if !path.is_file() {
        return Ok(T::default());
    }
    read_json(path)
}

fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn i64_of(value: &Value, fallback: i64) -> i64 {
    value.as_i64().unwrap_or(fallback)
}

fn u64_of(value: &Value, fallback: u64) -> u64 {
    value.as_u64().unwrap_or(fallback)
}

fn f64_of(value: &Value, fallback: f64) -> f64 {
    value.as_f64().unwrap_or(fallback)
}

fn bool_of(value: &Value, fallback: bool) -> bool {
    value.as_bool().unwrap_or(fallback)
}
