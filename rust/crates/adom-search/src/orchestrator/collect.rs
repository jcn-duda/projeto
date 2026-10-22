//! Coleta: o PLANO (quem consulta o quê) e a trait que executa cada tarefa.
//!
//! O plano é a parte pura e mora no núcleo (`adom_core::search_plan`); aqui só
//! se decide a TOPOLOGIA que a janela consome:
//!
//! - **grupo BR/prioritário separado dos globais** — é a tarefa que ganha a
//!   graça `BR_PARTIAL_GRACE_MS` quando só os globais chegaram (Disclosure Day);
//! - **`task_scope`** é o seletor do grupo (`priority`/`nonpriority`/`all`),
//!   então uma tarefa por grupo espelha o plano sem repetir a consulta;
//! - **prazo ABSOLUTO** (`deadline_at`, epoch ms) é o da RESPOSTA; quem subtrai
//!   a reserva de debrid é a janela (`collection_budget`), não o job. Passar a
//!   sobra já descontada faria o Node descontar de novo.
//!
//! A coleta em si é INJETADA ([`Collector`]): produção monta os coletores
//! nativos; teste usa stub. Falha de qualquer tarefa vira lote vazio + erro
//! observado — nunca derruba a busca.

use std::future::Future;
use std::pin::Pin;

use adom_core::{live_indexers, plan_jackett_queries};
use serde_json::Value;

use crate::internal_types::TaskScope;
use crate::orchestrator::live_state::LiveBatchState;
use crate::orchestrator::meta::SearchMeta;
use crate::raw_item::RawItem;

/// Seleção POR REQUISIÇÃO que governa QUEM a coleta consulta.
///
/// No Node isso sai do `encoded` (`opts().providers`/`jackettIndexers`/
/// `dubbedOnly`); aqui o orquestrador recebe as opções já decodificadas
/// (`SearchInput.options`). O gate congelado sempre teve isso
/// (`frozen_gate.rs:507-511`); a produção populava `config.selected_indexers`
/// com vazio e o `CollectJob` não levava os outros dois campos, então o
/// coletor nativo não honrava a seleção da request.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RequestSelection {
    /// `providers` (`p`): `both` ou os nomes escolhidos.
    pub providers: Vec<String>,
    /// `jackettIndexers` (`ji`) crus — inclui o card virtual `mico`.
    pub jackett_indexers: Vec<String>,
    /// `dubbedOnly` (`d`): fonte BR filtra legendado no scrape.
    pub dubbed_only: bool,
    /// `MICO_DEFAULT` do operador: vale quando a request não traz `ji`.
    pub mico_default: bool,
}

impl RequestSelection {
    /// Lê as três chaves das opções normalizadas. Tipo errado = ausente (o
    /// runtime do Node já grampeou antes de chegar aqui).
    pub fn from_options(options: &Value, mico_default: bool) -> Self {
        let list = |key: &str| -> Vec<String> {
            options
                .get(key)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        RequestSelection {
            providers: list("providers"),
            jackett_indexers: list("jackettIndexers"),
            dubbed_only: options
                .get("dubbedOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            mico_default,
        }
    }

    /// `ji` efetivo: a request vence; sem `ji` nela, o default do operador.
    /// É o "sem mudar o default" do plano — instalação sem seleção continua
    /// com o comportamento anterior (uma tarefa, lista do processo).
    pub fn jackett_selection(&self, operator_default: &[String]) -> Vec<String> {
        if self.jackett_indexers.is_empty() {
            operator_default.to_vec()
        } else {
            self.jackett_indexers.clone()
        }
    }
}

/// Card virtual do Mico no `ji`: não é indexer do Jackett.
pub(crate) fn jackett_only(indexers: &[String]) -> Vec<String> {
    indexers
        .iter()
        .filter(|indexer| !indexer.trim().eq_ignore_ascii_case("mico"))
        .cloned()
        .collect()
}

/// Uma tarefa de coleta com o prazo absoluto da resposta.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectJob {
    pub encoded: String,
    pub scope: TaskScope,
    /// Tipo Stremio (`movie` | `series`) — vai no campo JSON `type` da rota.
    /// NÃO é o rótulo do grupo (priority/global): isso é `scope`/`priority`.
    pub kind: String,
    pub imdb_id: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub year: Option<Value>,
    pub names: Vec<String>,
    pub query: String,
    pub pt_query: Option<String>,
    pub sweep_query: Option<String>,
    pub original_query: Option<String>,
    pub multi_work_query: Option<String>,
    /// `true` = grupo BR: entra na graça da janela, não na fatia global.
    pub priority: bool,
    /// Epoch ms do prazo da RESPOSTA.
    pub deadline_at: i64,
    /// Passe tardio da varredura pt-BR (`TailJob::PtSweep`): `ignore_breaker`
    /// liga; a varredura **inline** (task `sweep:true` no plano da coleta
    /// principal) NÃO — não misturar os dois caminhos.
    pub late_sweep: bool,
    /// `providers` da request (`p`): decide o `wants` por fonte.
    pub providers: Vec<String>,
    /// `ji` da request (cru, inclui `mico`). Vazio = default do operador.
    pub jackett_indexers: Vec<String>,
    /// `dubbedOnly` do usuário (fonte BR filtra legendado).
    pub dubbed_only: bool,
    /// `MICO_DEFAULT` do operador: vale quando `jackett_indexers` está vazio.
    pub mico_default: bool,
}

impl CollectJob {
    /// `jackettMode` do Node: `both` ou provider `jackett`. Sem `providers` na
    /// request (encoded ausente), vale o default do processo.
    pub fn jackett_mode(&self) -> bool {
        self.providers.is_empty()
            || self
                .providers
                .iter()
                .any(|provider| provider == "both" || provider == "jackett")
    }

    fn provider_selected(&self, name: &str) -> bool {
        self.providers.is_empty()
            || self
                .providers
                .iter()
                .any(|provider| provider == "both" || provider == name)
    }

    /// `mode === 'demo'` (sem `both`): o `collectRaw` responde do lote demo
    /// ANTES de qualquer fonte real; nenhuma tarefa nativa roda nesse modo.
    fn is_demo(&self) -> bool {
        !self.providers.iter().any(|provider| provider == "both")
            && self
                .providers
                .first()
                .is_some_and(|provider| provider == "demo")
    }

    /// Espelho do `wants` do `collectRaw` POR FONTE. `bludv` é independente do
    /// `providers` (só o kill-switch do cliente); `mico` exige `jackettMode` e
    /// o card no `ji` (ou o default do operador).
    pub fn wants(&self, source: &str) -> bool {
        if self.is_demo() {
            return false;
        }
        match source {
            "jackett" | "prowlarr" => self.provider_selected(source),
            "torrentio" => self.provider_selected("torrentio"),
            "mico" => {
                self.jackett_mode()
                    && if self.jackett_indexers.is_empty() {
                        self.mico_default
                    } else {
                        self.jackett_indexers
                            .iter()
                            .any(|indexer| indexer.trim().eq_ignore_ascii_case("mico"))
                    }
            }
            "bludv" => true,
            _ => false,
        }
    }

    /// Seleção que o plano Jackett deve consultar: `ji` da request (ou default
    /// do operador no job) SEM o card virtual.
    pub fn jackett_indexers_for_plan(&self) -> Vec<String> {
        jackett_only(&self.jackett_indexers)
    }
}

/// Lote devolvido por uma tarefa.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CollectBatch {
    pub items: Vec<RawItem>,
    /// A própria coleta do Node parou por prazo (`!done` no `collectRaw`).
    pub partial: bool,
    /// Estado vivo POR indexer do `collectRaw` (falha/pendente/vazio/agregado,
    /// `live.snapshot()` da rota interna). `None` = fonte sem contrato vivo
    /// (collector nativo, Node antigo): ausência NUNCA prova sucesso — quem
    /// consome cai na régua antiga, nunca em "todos responderam".
    pub live: Option<LiveBatchState>,
}

/// Executa UMA tarefa de coleta.
pub trait Collector: Send + Sync {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>>;
}

/// Monta as tarefas a partir do plano do núcleo.
///
/// Sem seleção de indexer (instalação sem `ji`), o plano não gera tarefa — mas
/// o `jackett.search` do Node cai no agregado `/all` com a config do operador.
/// Nesse caso a janela recebe UMA tarefa `all`, como o TS.
///
/// `kind` é o tipo Stremio (`movie`|`series`) — o Node valida `body.type`.
pub fn plan_jobs(
    config: &crate::orchestrator::config::OrchestratorConfig,
    meta: &SearchMeta,
    kind: &str,
    encoded: Option<&str>,
    deadline_at: i64,
    selection: &RequestSelection,
) -> Vec<CollectJob> {
    // Seleção da REQUEST (como o gate congelado); sem `ji` nela, cai no default
    // do operador (`config.selected_indexers` — com `JACKETT_INDEXERS` vazio, a
    // lista automática do volume do Jackett).
    let request_indexers = selection.jackett_selection(&config.selected_indexers);
    // Index-only ficam fora do caminho da resposta (colhem em fundo no Node).
    // O card virtual `mico` não é do Jackett: nunca vira consulta Torznab.
    let selected = live_indexers(
        &jackett_only(&request_indexers),
        &config.index_only_indexers,
        &[],
    );
    let sweep_query = if config.sweep_enabled {
        meta.sweep_query.clone()
    } else {
        None
    };
    let base = CollectJob {
        encoded: crate::request::encoded_for_internal(encoded),
        scope: TaskScope::All,
        kind: kind.to_string(),
        imdb_id: meta.imdb_id.clone(),
        season: meta.season,
        episode: meta.episode,
        year: Some(meta.year.clone()).filter(|v| !v.is_null()),
        names: meta.names.clone(),
        query: meta.query.clone(),
        pt_query: meta.pt_query.clone(),
        sweep_query: None,
        original_query: meta.original_query.clone(),
        multi_work_query: meta.multi_work_query.clone(),
        priority: false,
        deadline_at,
        late_sweep: false,
        providers: selection.providers.clone(),
        jackett_indexers: request_indexers,
        dubbed_only: selection.dubbed_only,
        mico_default: selection.mico_default,
    };
    if selected.is_empty() {
        return vec![CollectJob { ..base }];
    }
    let plan = plan_jackett_queries(
        &meta.query,
        meta.pt_query.as_deref(),
        &selected,
        &config.pt_br_indexers,
        &config.isolate_indexers,
        sweep_query.as_deref(),
        meta.original_query.as_deref(),
        meta.multi_work_query.as_deref(),
    );
    // A varredura é a tarefa marcada ESTRUTURALMENTE (`sweep:true`), nunca
    // inferida por igualdade de query — a tarefa BR isolada pode ter a mesma.
    let is_priority = |task: &adom_core::SearchPlanTask| {
        task.indexers
            .iter()
            .any(|indexer| config.pt_br_indexers.contains(indexer))
    };
    let has_global = plan
        .iter()
        .any(|t| !t.sweep.unwrap_or(false) && !is_priority(t));
    let has_priority = plan
        .iter()
        .any(|t| !t.sweep.unwrap_or(false) && is_priority(t));

    let mut jobs = Vec::new();
    if has_priority {
        jobs.push(CollectJob {
            scope: TaskScope::Priority,
            priority: true,
            ..base.clone()
        });
    }
    if has_global || !has_priority {
        jobs.push(CollectJob {
            scope: if has_priority {
                TaskScope::Nonpriority
            } else {
                TaskScope::All
            },
            // A query da varredura só vale onde há global para consultar.
            sweep_query: if has_global { sweep_query } else { None },
            ..base
        });
    }
    jobs
}

/// Tarefa ÚNICA do passe tardio: a varredura pt-BR nos globais.
///
/// A varredura inline já entrou no job de coleta (`sweep_query`); esta só roda
/// quando a coleta foi PARCIAL — o resto dos globais não estava no balde da
/// resposta. `priority=false`: a varredura nunca é a fonte BR.
///
/// `kind` é o tipo Stremio (`movie`|`series`) — igual ao da coleta principal.
pub fn sweep_job(
    config: &crate::orchestrator::config::OrchestratorConfig,
    meta: &SearchMeta,
    kind: &str,
    encoded: Option<&str>,
    deadline_at: i64,
    selection: &RequestSelection,
) -> Option<CollectJob> {
    let sweep_query = meta.sweep_query.clone().filter(|_| config.sweep_enabled)?;
    Some(CollectJob {
        encoded: crate::request::encoded_for_internal(encoded),
        scope: TaskScope::All,
        kind: kind.to_string(),
        imdb_id: meta.imdb_id.clone(),
        season: meta.season,
        episode: meta.episode,
        year: Some(meta.year.clone()).filter(|v| !v.is_null()),
        names: meta.names.clone(),
        query: meta.query.clone(),
        pt_query: meta.pt_query.clone(),
        sweep_query: Some(sweep_query),
        original_query: meta.original_query.clone(),
        multi_work_query: meta.multi_work_query.clone(),
        priority: false,
        deadline_at,
        late_sweep: true,
        providers: selection.providers.clone(),
        jackett_indexers: selection.jackett_selection(&config.selected_indexers),
        dubbed_only: selection.dubbed_only,
        mico_default: selection.mico_default,
    })
}

#[cfg(test)]
#[path = "collect_tests.rs"]
mod tests;
