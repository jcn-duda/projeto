//! Fim da passada: commit, URL de play, TTL e lote do índice.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::cache::{to_cacheable_entry, Fence, StreamsEntry};
use crate::internal_types::{EffectEntry, ReleaseEntry};
use crate::latest_writer::LatestWriter;
use crate::list_builder::{build_stream_list, BuildContext};
use crate::raw_item::RawItem;
use crate::request::encoded_for_internal;
use crate::resolve_url::ResolveSigner;

use super::config::{build_options_from, DebridContext, OrchestratorConfig};
use super::file_sizes::merge_file_sizes;
pub(super) use super::finish_build::finish_value;
use super::index_metrics as metrics;
use super::meta::SearchMeta;
use super::respond::as_ms;
use super::Orchestrator;

/// Entrada de uma computação (nada de referência à requisição que morreu).
#[derive(Clone)]
pub(super) struct SearchInput {
    pub(super) kind: String,
    pub(super) id: String,
    pub(super) encoded: Option<String>,
    pub(super) prefix: String,
    pub(super) options: Value,
    pub(super) key: String,
    pub(super) now_ms: i64,
    /// `None` = passe tardio, sem prazo de cliente.
    pub(super) deadline_at: Option<i64>,
    /// Geração da obra capturada JUNTO da leitura do cache (`get_fenced`). É a
    /// única fence que este passe pode usar para gravar: se a obra foi
    /// invalidada enquanto a coleta corria, o commit é descartado (5H).
    pub(super) fence: Fence,
}

/// O que a passada de build produziu, além da entrada gravável.
#[derive(Clone)]
pub(super) struct FinishValue {
    pub(super) entry: StreamsEntry,
    /// Lote pré-filtro de título (`entered` do banco de magnets).
    pub(super) entered: Vec<RawItem>,
    /// Lote pós-filtro de título (matéria-prima do índice de releases).
    pub(super) filtered: Vec<RawItem>,
    pub(super) partial: bool,
    pub(super) debrid_known: bool,
    pub(super) needs_debrid_refresh: bool,
    pub(super) commit_write: bool,
    pub(super) commit_ttl: i64,
    /// Efeitos de cauda decididos por ESTA passada (`EFFECTS_RUST`). Calculados
    /// aqui porque dependem do veredito de cache por stream; emitidos no tail.
    pub(super) effects: Vec<EffectEntry>,
}

/// Lote do índice de releases (`entered`/`survivors` do filtro de título).
pub(super) fn release_entry(
    meta: &SearchMeta,
    entered: &[RawItem],
    survivors: &[RawItem],
) -> ReleaseEntry {
    release_entry_parts(&meta.imdb_id, meta.season, meta.episode, entered, survivors)
}

/// Miolo de [`release_entry`] com os campos PRIMITIVOS da obra. Existe para o
/// colhedor de fundo montar a MESMA entrada (sem `SearchMeta`, sem
/// orquestrador): `orchestrator::harvest_support::release_entry_for` delega
/// aqui. A régua é uma só — não duplique.
pub(crate) fn release_entry_parts(
    imdb: &str,
    season: Option<i64>,
    episode: Option<i64>,
    entered: &[RawItem],
    survivors: &[RawItem],
) -> ReleaseEntry {
    // Zero auto-perpetuação (Etapa 4): a reserva 📦 NUNCA alimenta o índice de
    // releases nem o banco. No TS o `releaseIndex.record` recebe
    // `raw.filter(item => !item.fromFallback)`; aqui a reserva entra no build
    // para responder, mas sai antes da escrita.
    let recordable = |item: &&RawItem| !item.from_fallback;
    ReleaseEntry {
        imdb: imdb.to_string(),
        season,
        episode,
        items: survivors
            .iter()
            .filter(recordable)
            .map(RawItem::to_wire)
            .collect(),
        entered: Some(
            entered
                .iter()
                .filter(recordable)
                .map(RawItem::to_wire)
                .collect(),
        ),
        survivors: Some(
            survivors
                .iter()
                .filter(recordable)
                .map(RawItem::to_wire)
                .collect(),
        ),
        source: None,
        supplemental: false,
    }
}

pub(super) fn cache_max_age_for_finish(
    value: &FinishValue,
    collect_failed: bool,
    config: &OrchestratorConfig,
) -> u32 {
    let revalidation = value.entry.streams.is_empty()
        || value.partial
        || value.entry.notice
        || !value.debrid_known
        || value.needs_debrid_refresh
        || collect_failed;
    if revalidation {
        0
    } else {
        config.cache_ttl.max(0) as u32
    }
}
pub(super) fn str_of(options: &Value, key: &str) -> String {
    options
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub(super) fn bool_of(options: &Value, key: &str) -> bool {
    options.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub(super) fn is_demo(options: &Value) -> bool {
    options
        .get("providers")
        .and_then(Value::as_array)
        .map(|list| list.iter().any(|p| p.as_str() == Some("demo")))
        .unwrap_or(false)
}

impl Orchestrator {
    /// Uma passada do pipeline sobre um lote (resposta ou tardio).
    ///
    /// TUDO aqui é síncrono: o `DebridCheck` bloqueia no adaptador
    /// (`AdapterDebridCheck`), exatamente como o `applyDebrid` do TS. O
    /// `LatestWriter` decide SE esta versão commita (fase/revisão), e o
    /// `commit_decision` do núcleo decide O QUE gravar e com que TTL.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn finish(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
        writer: &LatestWriter,
        phase: u64,
        items: &[RawItem],
        partial: bool,
        deadline_at: Option<i64>,
    ) -> FinishValue {
        let mut ctx = self.build_context(input, meta);
        // A lista de arquivos vem por hash da fonte nativa; o mapa do replay
        // (já no contexto) continua vencendo. Antes disto o `💾` de pack nunca saía.
        merge_file_sizes(self.file_sizes.as_deref(), items, &mut ctx);
        let opts = build_options_from(&input.options, &self.config.build);
        let debrid_ctx = self.debrid_context(input, deadline_at);
        let signer = self.resolve_signer(input, meta);
        let store = self.store.clone();
        let key = input.key.clone();
        let now = input.now_ms;
        let fence = input.fence;
        let (value, _commit) = writer.run(
            phase,
            || {
                let mut check = self.debrid.make(&debrid_ctx);
                let built =
                    build_stream_list(items, &ctx, &opts, &mut *check, &self.config.display);
                finish_value(
                    built,
                    meta,
                    partial,
                    true,
                    &debrid_ctx,
                    &input.key,
                    &signer,
                    &self.config,
                    self.config.trace_enabled,
                    now,
                )
            },
            |value: &FinishValue| !value.entry.streams.is_empty(),
            |value: &FinishValue| {
                if !value.commit_write {
                    return;
                }
                let entry = to_cacheable_entry(&value.entry);
                let ttl = value.commit_ttl.max(0) as u64;
                if !store.set_fenced(&key, &entry, ttl, as_ms(now), fence) {
                    // Corrida perdida de propósito: a obra foi invalidada
                    // enquanto esta busca coletava. A lista sai na RESPOSTA,
                    // mas não entra no cache — gravar aqui ressuscitaria a
                    // invalidação que o operador (ou a outbox) acabou de pedir.
                    metrics::global_metrics().inc(metrics::COMMIT_DROPPED, 1);
                    eprintln!(
                        "[search] commit descartado: geração da obra andou durante a busca ({key})"
                    );
                }
            },
        );
        value
    }

    pub(super) fn build_context(&self, input: &SearchInput, meta: &SearchMeta) -> BuildContext {
        let service = str_of(&input.options, "debridService");
        let api_key = str_of(&input.options, "debridApiKey");
        // `pruneKnownBroken` nativo: `bad`/`lie` do banco de magnets DESTA conta.
        // Sem fonte/sem conta o conjunto é vazio — nenhuma régua nova, só a
        // evidência que o Node já usava.
        let broken_hashes = match self.known_broken.as_ref() {
            Some(source) if !service.is_empty() && !api_key.is_empty() => {
                source.broken_hashes(&service, &api_key, input.now_ms)
            }
            _ => HashSet::new(),
        };
        BuildContext {
            names: meta.names.clone(),
            year: meta.year_text(),
            alt_year: meta.alt_year.clone(),
            multi_work_root: meta.multi_work_root.clone(),
            season: meta.season,
            episode: meta.episode,
            is_demo: meta.is_demo,
            debrid_available: !service.is_empty() && !api_key.is_empty(),
            debrid_cache_check_honest: adom_core::cache_check_honest(&service),
            debrid_has_key: !api_key.is_empty(),
            debrid_cached_only: bool_of(&input.options, "debridCachedOnly"),
            show_uncached_br: bool_of(&input.options, "showUncachedBr"),
            // Operador, não usuário: `DEBRID_RESOLVE_UNCACHED`.
            debrid_resolve_uncached: self.config.resolve_uncached,
            // A checagem sempre roda no modo normal.
            debrid_check_disabled: false,
            // Data de estreia do episódio (epoch ms): liga a guarda de pré-air
            // de 48 h e a de episódio não exibido. Vem do `episodeAired` real
            // (Cinemeta) nas DUAS fontes de metadados.
            episode_aired_at_ms: meta.episode_aired_at_ms,
            // 1º lançamento doméstico (filtro de título do build).
            home_release_at: meta.home_release_at,
            episode_counts: meta.episode_counts.clone(),
            first_seen_ms: HashMap::new(),
            executable_bases: Vec::new(),
            // Contexto do ptTitleDual: o build decide in-process (o Node não
            // precisa mandar a flag no item).
            titles: meta.titles.clone(),
            now_ms: input.now_ms,
            files_by_hash: self.files_by_hash.as_ref().clone(),
            totals_by_hash: self.totals_by_hash.as_ref().clone(),
            files_at_build: self
                .files_at_build
                .as_ref()
                .map(|files| files.as_ref().clone()),
            totals_at_build: self
                .totals_at_build
                .as_ref()
                .map(|totals| totals.as_ref().clone()),
            broken_hashes,
        }
    }

    fn debrid_context(&self, input: &SearchInput, deadline_at: Option<i64>) -> DebridContext {
        DebridContext {
            service: str_of(&input.options, "debridService"),
            api_key: str_of(&input.options, "debridApiKey"),
            encoded: Some(encoded_for_internal(input.encoded.as_deref())),
            deadline_at,
        }
    }

    fn resolve_signer(&self, input: &SearchInput, meta: &SearchMeta) -> ResolveSigner {
        let api_key = str_of(&input.options, "debridApiKey");
        ResolveSigner {
            prefix: input.prefix.clone(),
            // `resolveSecret || debridApiKey || ''` (sign.ts:15-17).
            secret: if self.config.resolve_secret.is_empty() {
                api_key
            } else {
                self.config.resolve_secret.clone()
            },
            season: meta.season,
            episode: meta.episode,
            imdb_id: Some(meta.imdb_id.clone()).filter(|id| !id.is_empty()),
            work_hint: None,
        }
    }
}

#[cfg(test)]
#[path = "finish_tests.rs"]
mod finish_tests;
