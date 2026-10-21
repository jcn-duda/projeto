//! Inventário NATIVO da conta do debrid como fonte (F3) e o fast-path da conta.
//!
//! O Node segue dono de `account.ts`, do memo `dinv`, do `davail`, do hold e do
//! autofetch. Esta fatia porta o mínimo para a busca não depender de nenhuma
//! tarefa Node do inventário:
//!
//! - **leitura** (`adom_debrid::account`) com veredito `known`/`unusable`;
//! - **filtro** de relevância da conta (`filter_inventory_relevant` do núcleo,
//!   com as mesmas quatro sondas de áudio/origem do `audioSignalsMany`);
//! - **memo** local por serviço+conta (`dinv` do Node é TTL 300s; falha nunca
//!   fica gravada);
//! - **fast-path** (`stopWhen` do `collectRaw`: lote da conta suficiente
//!   responde na hora).
//!
//! A fonte nativa é a ÚNICA da conta: não há mais modo `off`/`on` nem tarefa
//! Node. `ACCOUNT_FAST_PATH`/`ACCOUNT_FAST_MIN_*` continuam como kill-switch e
//! limiares do operador. Nenhum estado persistido é criado por esta fatia.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_core::{
    account_scope, audio_signals, br_origin_mark, filter_inventory_relevant,
    has_explicit_foreign_audio, RelevanceItem, RelevanceQuery, RelevanceSettings,
};
use adom_debrid::account::{fetch_inventory, AccountInventory, InventoryItem, InventoryOpts};
use adom_debrid::verdict::UnusableKind;
use serde_json::Value;

use crate::collection_window::BatchMeta;
use crate::raw_item::{known_size, RawItem};

use super::account_metrics as metrics;
use super::config::OrchestratorConfig;
use super::meta::SearchMeta;
use super::respond::now_ms;

/// `ACCOUNT_FAST_PATH` do Node (default ligado).
pub const FAST_PATH_ENV: &str = "ACCOUNT_FAST_PATH";
/// `ACCOUNT_FAST_MIN_RELEASES` do Node (default 2).
pub const FAST_PATH_MIN_ENV: &str = "ACCOUNT_FAST_MIN_RELEASES";

/// Identidade da conta para UMA leitura (chave nunca vai para log).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRequest {
    pub service: String,
    pub api_key: String,
}

impl AccountRequest {
    /// `false` = P2P puro (sem serviço/chave o Node também não tem adapter).
    pub fn is_active(&self) -> bool {
        !self.service.is_empty() && !self.api_key.is_empty()
    }
}

/// Fonte do inventário. Abstração pequena para o teste injetar fixture e para
/// a busca degradar sem rede quando não há fonte.
pub trait AccountInventorySource: Send + Sync {
    fn inventory<'a>(
        &'a self,
        req: AccountRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AccountInventory, String>> + Send + 'a>>;
}

/// Limites/estado do memo do inventário nativo.
#[derive(Debug, Clone, Copy)]
pub struct NativeAccountConfig {
    pub timeout: Duration,
    pub max: usize,
    /// TTL do memo `dinv` (`DEBRID_INVENTORY_TTL`, 300s no Node).
    pub ttl_ms: i64,
}

impl Default for NativeAccountConfig {
    fn default() -> Self {
        NativeAccountConfig {
            timeout: adom_debrid::account::DEFAULT_TIMEOUT,
            max: adom_debrid::account::DEFAULT_MAX,
            ttl_ms: 300_000,
        }
    }
}

impl NativeAccountConfig {
    pub fn from_orchestrator(config: &OrchestratorConfig) -> Self {
        NativeAccountConfig {
            timeout: Duration::from_millis(config.account_inventory_timeout_ms.max(1) as u64),
            max: config.account_inventory_max.max(1),
            ttl_ms: config.account_inventory_ttl_s.max(0) * 1_000,
        }
    }
}

/// Fonte de produção: HTTP do `adom-debrid` + memo em processo (o `dinv` do
/// Node não é tocado — o store Rust não é dono desse namespace).
pub struct NativeAccountSource {
    config: NativeAccountConfig,
    memo: Mutex<HashMap<String, (i64, AccountInventory)>>,
}

impl NativeAccountSource {
    pub fn new(config: NativeAccountConfig) -> Self {
        NativeAccountSource {
            config,
            memo: Mutex::new(HashMap::new()),
        }
    }

    /// Chave por serviço+conta (`accountScope` = sha256 da chave, como no Node).
    fn memo_key(req: &AccountRequest) -> String {
        format!(
            "{}:{}",
            req.service,
            account_scope(&Value::String(req.api_key.clone()))
        )
    }

    /// Grava no memo com teto: conta de usuário é privada e o processo é
    /// longo; sem poda, cada conta nova ficaria para sempre. Expira primeiro
    /// quem vence primeiro (o Node tem cota no `cache.db`).
    fn store_memo(&self, key: String, now: i64, inventory: AccountInventory) {
        const MAX_ENTRIES: usize = 64;
        let mut guard = self.memo.lock().unwrap_or_else(|err| err.into_inner());
        if guard.len() >= MAX_ENTRIES && !guard.contains_key(&key) {
            guard.retain(|_, (expires_at, _)| *expires_at > now);
            if guard.len() >= MAX_ENTRIES {
                let oldest = guard
                    .iter()
                    .min_by_key(|(_, (expires_at, _))| *expires_at)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    guard.remove(&oldest);
                }
            }
        }
        guard.insert(key, (now.saturating_add(self.config.ttl_ms), inventory));
    }
}

impl AccountInventorySource for NativeAccountSource {
    fn inventory<'a>(
        &'a self,
        req: AccountRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AccountInventory, String>> + Send + 'a>> {
        Box::pin(async move {
            let key = Self::memo_key(&req);
            let now = now_ms();
            {
                let mut guard = self.memo.lock().unwrap_or_else(|err| err.into_inner());
                if let Some((expires_at, inventory)) = guard.get(&key) {
                    if *expires_at > now {
                        metrics::global_metrics().inc(metrics::MEMO_HIT, 1);
                        return Ok(inventory.clone());
                    }
                    guard.remove(&key);
                }
            }
            let inventory = match fetch_inventory(
                &req.service,
                &req.api_key,
                InventoryOpts {
                    timeout: self.config.timeout,
                    max: self.config.max,
                },
            )
            .await
            {
                Ok(inventory) => inventory,
                Err(err) => {
                    metrics::global_metrics().inc(metrics::UNKNOWN, 1);
                    return Err(err);
                }
            };
            record_metrics(&inventory);
            // Falha NUNCA fica no memo (o Node também não cacheia erro): a
            // próxima busca tenta de novo.
            if inventory.known {
                self.store_memo(key, now, inventory.clone());
            }
            Ok(inventory)
        })
    }
}

fn record_metrics(inventory: &AccountInventory) {
    let metrics = metrics::global_metrics();
    metrics.inc(metrics::FETCH, 1);
    if inventory.known {
        metrics.inc(metrics::KNOWN, 1);
        metrics.inc(metrics::ITEMS, inventory.items.len() as u64);
        if inventory.items.is_empty() {
            metrics.inc(metrics::EMPTY, 1);
        }
        return;
    }
    match inventory.unusable.as_ref().map(|(kind, _)| kind) {
        Some(UnusableKind::Auth) => metrics.inc(metrics::UNUSABLE_AUTH, 1),
        Some(UnusableKind::Quota) => metrics.inc(metrics::UNUSABLE_QUOTA, 1),
        None => metrics.inc(metrics::UNKNOWN, 1),
    }
}

// ── Sondas de áudio/origem do `audioSignalsMany` ───────────────────────────

/// As quatro sondas do lote do TS para UM título.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AccountSignals {
    /// `looksPtBr` — vira `isBr` do item antes do filtro.
    pub pt_audio: bool,
    /// `hasExplicitForeignAudio` — desmente a origem BR.
    pub explicit_foreign: bool,
    /// `audioFromTitle(title) === 'Legendado'`.
    pub legendado: bool,
    /// `brOriginMark` — origem BR pelo nome (8.4).
    pub br_origin: bool,
}

/// Uma passada por título (o `audioSignalsMany` do Node).
pub fn signals_of(title: &str) -> AccountSignals {
    let signals = audio_signals(title);
    AccountSignals {
        pt_audio: signals.looks_pt_br,
        explicit_foreign: has_explicit_foreign_audio(title),
        legendado: signals.audio == "Legendado",
        br_origin: br_origin_mark(title),
    }
}

/// `origemBrSemProvaDeAudio` do `account.ts`: origem BR não promete áudio —
/// vaga reservada sim, `_dubbed` não. Guardas em conjunção.
pub fn br_origin_only(signals: &AccountSignals) -> bool {
    !signals.pt_audio && !signals.explicit_foreign && !signals.legendado && signals.br_origin
}

/// Filtra o inventário e devolve os itens no shape do `account.search` do TS:
/// `seeders:1`, `tracker` = label do serviço, `indexer:'debrid'`,
/// `fromAccount:true`, `isBr` = `looksPtBr || brOriginOnly`.
///
/// O filtro é o MESMO do Node (`filterInventoryRelevant`: estrito + exceção de
/// pack multiobra), e é ele que autoriza o build a pular o filtro de título
/// para itens `from_account`.
pub fn account_raw_items(
    items: &[InventoryItem],
    meta: &SearchMeta,
    settings: RelevanceSettings,
    label: &str,
) -> Vec<RawItem> {
    if items.is_empty() || meta.names.is_empty() {
        return Vec::new();
    }
    let signals: Vec<AccountSignals> = items.iter().map(|item| signals_of(&item.title)).collect();
    let relevance: Vec<RelevanceItem> = items
        .iter()
        .zip(&signals)
        .map(|(item, signals)| RelevanceItem {
            title: Some(item.title.clone()),
            is_br: signals.pt_audio,
            ..RelevanceItem::default()
        })
        .collect();
    let year = meta.year_text();
    let query = RelevanceQuery {
        names: &meta.names,
        year: &year,
        alt_year: meta.alt_year.as_deref(),
        is_series: meta.season.is_some(),
        season: meta.season,
        episode: meta.episode,
        multi_work_root: meta.multi_work_root.as_deref(),
        home_release_at: None,
    };
    let outcome = filter_inventory_relevant(&relevance, &query, &settings);
    outcome
        .kept
        .iter()
        .map(|&index| {
            let item = &items[index];
            let signals = &signals[index];
            let br_only = br_origin_only(signals);
            RawItem {
                title: Some(item.title.clone()),
                info_hash: Some(item.info_hash.clone()),
                // A conta não tem swarm: 1 é o valor neutro das fontes BR (0
                // morreria no filtro de seeders antes de virar stream).
                seeders: Some(1.0),
                size_bytes: known_size(Some(item.size)),
                tracker: Some(label.to_string()),
                indexer: Some("debrid".to_string()),
                is_br: signals.pt_audio || br_only,
                br_origin_only: br_only,
                from_account: true,
                ..RawItem::default()
            }
        })
        .collect()
}

// ── Fast-path da conta (`stopWhen` do collectRaw) ──────────────────────────

/// Decisão do fast-path da conta para um lote da janela.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FastPathDecision {
    /// Não é o lote da conta: nada a parar.
    NotAccount,
    /// Lote da conta abaixo do mínimo de releases.
    TooFew,
    /// `preferDubbed` pedido e o lote não cobre dublado.
    NotCovered,
    /// Suficiente: a resposta pode sair agora e o resto segue em fundo.
    Covered,
}

impl FastPathDecision {
    pub fn stops(self) -> bool {
        matches!(self, Self::Covered)
    }
}

/// Réplica do `stopWhen` de `collect-orchestrator.ts`:
/// - só o lote com `source === 'account'` decide;
/// - `batch.length >= minReleases`;
/// - com `preferDubbed`, o lote precisa cobrir dublado (`poolCovered` com
///   `requireDubbed:true`).
///
/// `season` é o mesmo do `matchContext`; `min_seeders` vem do operador.
pub fn fast_path_decision(
    batch: &[RawItem],
    meta: &BatchMeta,
    min_releases: usize,
    prefer_dubbed: bool,
    season: Option<i64>,
    min_seeders: f64,
) -> FastPathDecision {
    if meta.source.as_deref() != Some("account") {
        return FastPathDecision::NotAccount;
    }
    if batch.len() < min_releases.max(1) {
        return FastPathDecision::TooFew;
    }
    if prefer_dubbed {
        let coverage: Vec<adom_core::PoolCoverageItem> = batch
            .iter()
            .map(|item| adom_core::PoolCoverageItem {
                title: item.title.clone(),
                seeders: item.seeders.map(|n| serde_json::json!(n)),
                hash: item.info_hash.clone(),
                is_br: item.is_br,
                ..adom_core::PoolCoverageItem::default()
            })
            .collect();
        if !adom_core::pool_covered(&coverage, season, true, min_seeders) {
            return FastPathDecision::NotCovered;
        }
    }
    FastPathDecision::Covered
}

/// Registra a decisão do fast-path nas métricas próprias.
pub fn record_fast_path(decision: FastPathDecision) {
    let metrics = metrics::global_metrics();
    match decision {
        FastPathDecision::Covered => metrics.inc(metrics::FAST_PATH, 1),
        FastPathDecision::TooFew | FastPathDecision::NotCovered => {
            metrics.inc(metrics::FAST_PATH_SKIPPED, 1)
        }
        FastPathDecision::NotAccount => {}
    }
}

// ── Fábrica de produção ────────────────────────────────────────────────────

/// Fonte nativa do inventário. É a única fonte da conta: o orquestrador a
/// injeta sempre que o serviço da request é conhecido e a leitura está ligada.
pub fn try_native_account_source(
    config: &OrchestratorConfig,
) -> Option<Arc<dyn AccountInventorySource>> {
    Some(Arc::new(NativeAccountSource::new(
        NativeAccountConfig::from_orchestrator(config),
    )))
}

#[cfg(test)]
#[path = "account_tests.rs"]
mod account_tests;
