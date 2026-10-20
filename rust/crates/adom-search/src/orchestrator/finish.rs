//! Fim da passada: commit, URL de play, TTL e lote do índice.

use std::collections::HashMap;

use serde_json::Value;

use adom_core::{commit_decision, play_disposition, CommitFacts, PlayDisposition, PlayFacts};

use crate::cache::{has_playable_stream, to_cacheable_entry, StreamsEntry};
use crate::contract::StreamItem;
use crate::internal_types::{EffectEntry, ReleaseEntry};
use crate::latest_writer::LatestWriter;
use crate::list_builder::{build_stream_list, BuildContext};
use crate::raw_item::RawItem;
use crate::request::encoded_for_internal;
use crate::resolve_url::ResolveSigner;

use super::config::{build_options_from, DebridContext, NoDebridCheck, OrchestratorConfig};
use super::meta::SearchMeta;
use super::respond::as_ms;
use super::trace::{self, new_trace};
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

/// Fim da passada: entrada gravável + fatos da resposta.
#[allow(clippy::too_many_arguments)]
pub(super) fn finish_value(
    built: crate::list_builder::BuiltList,
    meta: &SearchMeta,
    partial: bool,
    // A checagem rodou? Sombra (§9.1) suprime o debrid: `Unknown` não é
    // degradação, é ausência de pergunta.
    debrid_checked: bool,
    debrid: &DebridContext,
    search_key: &str,
    signer: &ResolveSigner,
    config: &OrchestratorConfig,
    trace_enabled: bool,
    now_ms: i64,
) -> FinishValue {
    // A URL de play nasce AQUI (prefixo/segredo são da requisição) e RELATIVA:
    // o host entra em `applyNoticeOrigin`, nunca no cache. O item resolvido
    // perde `infoHash`/`sources`, como no Node.
    let mut built = built;
    let signer = ResolveSigner {
        work_hint: built.work_hint.clone(),
        ..signer.clone()
    };
    let short = debrid_short(&debrid.service);
    // Sem debrid ativo ninguém perguntou — e isso NÃO é "não tem" (o TS nem
    // chama o applyDebrid: `known` fica undefined → conhecido).
    let debrid_known = if debrid.is_active() {
        built.debrid_known && !built.needs_debrid_refresh
    } else {
        true
    };
    // `known:false` do LOTE → lista inteira pelo `/resolve` (degradado), como o
    // `materialize` do Node. O multiobra admitido continua fora dessa regra
    // (o núcleo decide; sem o knob ele já saiu no finalize).
    // Só há `resolveUncached`/degradação com debrid ATIVO e veredito utilizável:
    // sem serviço/chave ninguém perguntou, e `Unusable` (auth/quota) é conta que
    // não responde — o Node devolve P2P e descarta multiobra nesses caminhos.
    let check_usable = debrid_checked && debrid.is_active() && !built.debrid_unusable;
    let degraded = check_usable && !debrid_known;
    let resolve_uncached = check_usable && config.resolve_uncached;
    let unusable = built.debrid_unusable;
    let mut materialized: Vec<_> = Vec::with_capacity(built.streams.len());
    for mut stream in built.streams.drain(..) {
        let hash = stream.info_hash.clone().filter(|h| !h.is_empty());
        let disposition = play_disposition(&PlayFacts {
            has_info_hash: hash.is_some(),
            multi_work_admitted: stream.multi_work_admitted,
            // `Unusable` descarta até o ⚡ do memo: a conta não responde, então
            // a lista inteira volta P2P, como o `filter` do Node.
            cached: stream.cached && !unusable,
            // Sombra: sem checagem não há "frio conhecido" a resolver.
            resolve_uncached,
            degraded,
        });
        match disposition {
            // Defensivo: o finalize já removeu. Nunca oferecer a coleção fria.
            PlayDisposition::Drop => continue,
            PlayDisposition::P2p => {}
            PlayDisposition::Resolve => {
                // Sem hash o `/resolve` não existe: `viaDebrid` devolve o
                // stream como P2P antes de montar a URL (mesmo no degradado).
                if let Some(hash) = hash {
                    // `p:1` do `viaDebrid`: `workHint && s._multiWork`, e o
                    // `_multiWork` do Node já é `isMultiWorkCollection(title) ||
                    // _multiWorkAdmitted`. A marca genérica basta — exigir
                    // admissão perderia o pack de trilogia sem opt-in TMDB.
                    let multi_work = stream.multi_work || stream.multi_work_admitted;
                    let url = signer.url(&hash, stream.dubbed, multi_work);
                    stream.item.url = Some(url);
                    stream.item.info_hash = None;
                    stream.item.sources = None;
                    // `[AD⚡]` só no tocável; frio via knob/degradado é
                    // `[AD download]` — mesmo `markDebridName` do Node.
                    if let Some(name) = stream.item.name.clone() {
                        stream.item.name =
                            Some(adom_core::mark_debrid_name(&name, short, stream.cached));
                    }
                }
            }
        }
        materialized.push(stream);
    }
    built.streams = materialized;

    // Ledger: o funil do build vira `stages`; `final` fecha o tamanho entregue.
    let mut trace = new_trace(now_ms as f64, trace_enabled);
    trace::record_build_stages(&mut trace, &built.funnel);
    trace::finish_trace(&mut trace, built.streams.len(), now_ms as f64);
    let trace_value = trace::trace_to_cache_value(trace.as_ref());

    let streams: Vec<StreamItem> = built.streams.iter().map(|s| s.item.clone()).collect();
    let notice = !built.streams.is_empty() && built.streams.iter().all(|s| s.notice);
    let needs_debrid_refresh = debrid.is_active() && built.needs_debrid_refresh;
    let mut entry = StreamsEntry {
        streams,
        partial: partial || built.fallback,
        debrid_known: Some(debrid_known),
        fallback: built.fallback,
        notice,
        trace: trace_value,
        search_meta: Some(meta.search_meta_json()),
    };
    let decision = commit_decision(&CommitFacts {
        playable: has_playable_stream(&entry.streams),
        partial: entry.partial,
        debrid_known: entry.debrid_known,
        needs_debrid_refresh,
        has_fallback: built.fallback,
        cache_ttl: config.cache_ttl,
        fallback_streams_ttl: config.fallback_streams_ttl,
    });
    entry.partial = decision.partial;
    entry.debrid_known = Some(decision.debrid_known);
    // TTL <= 0 é cache desligado: não grava (mesma leitura do ramo da reserva).
    let commit_write = decision.write && decision.ttl > 0;
    let partial_entry = entry.partial;
    // Efeitos de cauda: o payload nasce aqui porque ele lê o veredito de cache
    // por stream; QUEM emite é o tail, atrás de `EFFECTS_RUST` (default OFF).
    //
    // Os dois early returns do `applyDebrid` que NÃO enfileiram nada:
    // sem adaptador (sem serviço/chave, `:87`) e conta `unusable`/auth-quota
    // (`:159-170`). Nos dois o Node não esquenta nem interroga nada.
    let effects = if debrid.is_active() && !built.debrid_unusable {
        let effect_ctx = super::effects::EffectContext {
            adapter_id: &debrid.service,
            api_key: &debrid.api_key,
            imdb_id: &meta.imdb_id,
            season: meta.season,
            episode: meta.episode,
            search_key,
            known: debrid_known,
            work: built.work_hint.as_ref(),
        };
        super::effects::build_effects(&built.effect_seeds, &effect_ctx)
    } else {
        Vec::new()
    };
    FinishValue {
        entry,
        entered: built.entered_raw,
        filtered: built.filtered_raw,
        partial: partial_entry,
        debrid_known,
        needs_debrid_refresh,
        commit_write,
        commit_ttl: decision.ttl,
        effects,
    }
}

/// Lote do índice de releases (`entered`/`survivors` do filtro de título).
pub(super) fn release_entry(
    meta: &SearchMeta,
    entered: &[RawItem],
    survivors: &[RawItem],
) -> ReleaseEntry {
    // Zero auto-perpetuação (Etapa 4): a reserva 📦 NUNCA alimenta o índice de
    // releases nem o banco. No TS o `releaseIndex.record` recebe
    // `raw.filter(item => !item.fromFallback)`; aqui a reserva entra no build
    // para responder, mas sai antes da escrita.
    let recordable = |item: &&RawItem| !item.from_fallback;
    ReleaseEntry {
        imdb: meta.imdb_id.clone(),
        season: meta.season,
        episode: meta.episode,
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

/// Sigla do adaptador no rótulo da lista (`short` do registry TS).
fn debrid_short(service: &str) -> &'static str {
    match service {
        "alldebrid" => "AD",
        "premiumize" => "PM",
        "torbox" => "TB",
        "realdebrid" => "RD",
        "debridlink" => "DL",
        _ => "",
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
        let ctx = self.build_context(input, meta);
        let opts = build_options_from(&input.options, &self.config.build);
        let debrid_ctx = self.debrid_context(input, deadline_at);
        let signer = self.resolve_signer(input, meta);
        let store = self.store.clone();
        let key = input.key.clone();
        let now = input.now_ms;
        let shadow = self.shadow_mode;
        let (value, _commit) = writer.run(
            phase,
            || {
                // Sombra: nunca pergunta ao debrid (nem via fábrica injetada).
                let mut check: Box<dyn crate::list_builder::DebridCheck + Send> = if shadow {
                    Box::new(NoDebridCheck)
                } else {
                    self.debrid.make(&debrid_ctx)
                };
                let built =
                    build_stream_list(items, &ctx, &opts, &mut *check, &self.config.display);
                finish_value(
                    built,
                    meta,
                    partial,
                    !shadow,
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
                if shadow {
                    return;
                }
                if value.commit_write {
                    let entry = to_cacheable_entry(&value.entry);
                    store.set(&key, &entry, value.commit_ttl.max(0) as u64, as_ms(now));
                }
            },
        );
        value
    }

    pub(super) fn build_context(&self, input: &SearchInput, meta: &SearchMeta) -> BuildContext {
        let service = str_of(&input.options, "debridService");
        let api_key = str_of(&input.options, "debridApiKey");
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
            // Sombra: NoDebridCheck responde Unknown sem ter perguntado.
            debrid_check_disabled: self.shadow_mode,
            // Data de estreia do episódio: o parser de data fica para a fatia
            // seguinte (ver `meta.rs`); sem ela a guarda de pré-air não roda.
            episode_aired_at_ms: None,
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
