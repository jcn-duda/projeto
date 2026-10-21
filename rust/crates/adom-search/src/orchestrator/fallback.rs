//! Reinjeção da reserva 📦 do banco em CADA build da busca.
//!
//! Espelho de `collectFallbackForBuild` (`search-orchestrator.ts`): a decisão
//! de QUANDO consultar (`live.needsFallback()`) e o que fazer com o resultado
//! (anexar ao lote, sem tocar no lote canônico) é a mesma; a seleção pura mora
//! em `adom-core::fallback_bank`, e a leitura do SQLite continua no Node por
//! `POST /internal/search/fallback`.
//!
//! Regra de ouro do TS que este módulo preserva: o lote VIVO é a autoridade.
//! `liveHashes` é calculado sobre os itens DESTA build e o núcleo corta a
//! reserva homônima antes dos tetos, independentemente de seeders. A reserva é
//! sempre devolvida como cópia para o build — nunca é gravada no `Vec` canônico,
//! senão a próxima reconstrução a trataria como item vivo.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::time::Duration;

use serde_json::Map;

use adom_core::{
    collect_fallback, FallbackInput, FallbackItem, FallbackMagnet, FallbackSource, FallbackWork,
    WorkTarget,
};

use crate::internal_types::FallbackRequest;
use crate::raw_item::{raw_item_from_value, RawItem};

use super::finish::SearchInput;
use super::index_metrics as metrics;
use super::index_source::{allowed_source_indexer, bank_limits, bank_read_window, obra_targets};
use super::live_state::LiveBatchState;
use super::meta::SearchMeta;
use super::respond::now_ms;
use super::Orchestrator;

/// Teto da chamada da reserva. A rota só lê SQLite no loopback; se não
/// responder rápido, o prazo do cliente vale mais que a reserva.
const FALLBACK_CALL_CAP_MS: i64 = 1_500;
/// Abaixo disso não sobra tempo útil para a leitura: nem chama a rota.
const FALLBACK_CALL_FLOOR_MS: i64 = 100;
/// Folga para o build/resposta antes do prazo absoluto do cliente. Também
/// absorve a margem de rede do `timeout_until` do cliente HTTP.
const FALLBACK_DEADLINE_MARGIN_MS: i64 = 250;

/// Orçamento da chamada da reserva a partir do prazo ABSOLUTO da busca.
///
/// - `None` (passe tardio, sem cliente esperando): usa o teto curto.
/// - Com prazo: `restante − margem`, limitado ao teto. Restante insuficiente
///   devolve `None` — fail-open imediato, sem gastar o prazo que resta.
///
/// A decisão usa relógio de parede (o mesmo do `deadline_at`), não
/// `input.now_ms`, que é a foto do INÍCIO da requisição: metadados e coleta já
/// consumiram parte do orçamento.
fn fallback_call_budget(deadline_at: Option<i64>, now: i64) -> Option<Duration> {
    let budget_ms = match deadline_at {
        None => FALLBACK_CALL_CAP_MS,
        Some(deadline_at) => {
            let remaining = deadline_at.saturating_sub(now);
            let usable = remaining.saturating_sub(FALLBACK_DEADLINE_MARGIN_MS);
            if usable < FALLBACK_CALL_FLOOR_MS {
                return None;
            }
            usable.min(FALLBACK_CALL_CAP_MS)
        }
    };
    Some(Duration::from_millis(budget_ms as u64))
}

/// `toRawItem` do TS. `dubbed`/`quality` viajam em `extra`: `dubbed` alimenta
/// o `_bankDub` (evidência do classificador) e `fallbackFetchable` é copiado
/// em `list_builder::helpers`.
///
/// NÃO passar a resposta da rota por `raw_item_from_value`: aquele parser
/// inicializa `extra` VAZIO (só conhece os campos do contrato), então
/// `fallbackFetchable`/`dubbed`/`quality` se perderiam. A reserva tem este
/// construtor dedicado justamente para preservar o fio de flags até
/// `map_stream` → `RankingStream.extra` → `ranking_to_pool`.
fn raw_item_from_fallback(item: &FallbackItem) -> RawItem {
    let mut extra = Map::new();
    extra.insert("dubbed".to_string(), item.dubbed.into());
    if !item.quality.is_empty() {
        extra.insert("quality".to_string(), item.quality.clone().into());
    }
    if item.fallback_fetchable {
        extra.insert("fallbackFetchable".to_string(), true.into());
    }
    RawItem {
        title: Some(item.title.clone()),
        info_hash: Some(item.info_hash.clone()),
        magnet: item.magnet.clone(),
        seeders: Some(item.seeders as f64),
        size_bytes: item.size.map(|size| size as f64),
        indexer: Some(item.indexer.clone()),
        tracker: (!item.tracker.is_empty()).then(|| item.tracker.clone()),
        is_br: item.is_br,
        from_fallback: true,
        extra,
        ..RawItem::default()
    }
}

fn core_input(
    resp: crate::internal_types::FallbackResponse,
    meta: &SearchMeta,
    live: &LiveBatchState,
    live_hashes: BTreeSet<String>,
) -> FallbackInput {
    let works = resp
        .works
        .iter()
        .filter(|work| !work.magnet.as_ref().is_some_and(|magnet| magnet.broken))
        .map(|work| FallbackWork {
            hash: work.hash.clone(),
            passed_filter: work.passed_filter,
            last_seen: work.last_seen,
            magnet: work.magnet.as_ref().map(|magnet| FallbackMagnet {
                hash: magnet.hash.clone(),
                uri: magnet.uri.clone(),
                title: magnet.title.clone(),
                size: magnet.size,
                is_br: magnet.is_br,
                dubbed: magnet.dubbed,
                quality: magnet.quality.clone(),
                seeders_max: magnet.seeders_max,
                seeders_last: magnet.seeders_last,
                last_seen: magnet.last_seen,
                lied: magnet.lied,
            }),
        })
        .collect();
    let sources = resp
        .sources
        .iter()
        .map(|(hash, list)| {
            (
                hash.clone(),
                list.iter()
                    .map(|source| FallbackSource {
                        indexer: source.indexer.clone(),
                        tracker: source.tracker.clone(),
                        last_seen: source.last_seen,
                        allowed: source.allowed,
                    })
                    .collect(),
            )
        })
        .collect();
    FallbackInput {
        enabled: resp.enabled,
        fallback_enabled: resp.fallback_enabled,
        imdb_id: meta.imdb_id.clone(),
        work_target: WorkTarget {
            season: meta.season,
            episode: meta.episode,
        },
        live_hashes: live_hashes.into_iter().collect(),
        failed: live.failed_indexers().into_iter().collect(),
        suspect: live.suspect_indexers().into_iter().collect(),
        all_failed: live.all.failed(),
        per_indexer_max: resp.per_indexer_max,
        global_max: resp.global_max,
        br_indexers: resp.br_indexers,
        index_only_indexers: resp.index_only_indexers,
        works,
        sources,
    }
}

impl Orchestrator {
    /// Devolve o lote vivo com a reserva 📦 anexada. Fail-open: banco fora,
    /// rota ausente ou nada elegível devolvem o lote original.
    ///
    /// Chamar em TODA build relevante (resposta, lote tardio, refresh de debrid
    /// e pack), com o estado vivo daquele instante — nunca uma foto congelada
    /// antes de a coleta assentar.
    pub(super) async fn with_fallback(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
        mut items: Vec<RawItem>,
        live: Option<&LiveBatchState>,
    ) -> Vec<RawItem> {
        let Some(live) = live else {
            return items;
        };
        if !live.needs_fallback() {
            return items;
        }
        // Banco nativo (`BANK_RUST=on`): a leitura do SQLite e o `collect_fallback`
        // do núcleo rodam in-process; a rota Node nem é chamada.
        if self.config.bank_mode.is_on() {
            if self.bank.is_some() {
                let out = self.native_fallback_result(input, meta, &items, live);
                if out.is_empty() {
                    return items;
                }
                eprintln!(
                    "[search] reserva do banco (nativo): {} item(ns) para {}",
                    out.len(),
                    meta.imdb_id
                );
                items.extend(out.iter().map(raw_item_from_fallback));
                return items;
            }
            metrics::global_metrics().inc(metrics::SOURCE_MISSING, 1);
        }
        let Some(routes) = self.routes.as_ref() else {
            return items;
        };
        // Replay congelado: o caso grava o RESULTADO da reserva
        // (`collectFallbackForBuild`), não as linhas do banco. Injetar os itens
        // gravados é o mesmo `[...items, ...fallback.items]` do Node; sem isto
        // a reserva inteira some (e os itens vivos que ela venceria mudam de
        // posição). O atalho só existe nesse modo (`None` em produção).
        if let Ok(Some(recorded)) = routes.fallback_injected().await {
            if recorded.is_empty() {
                return items;
            }
            let mut out = items;
            out.extend(recorded.iter().map(raw_item_from_value));
            return out;
        }
        let live_hashes: BTreeSet<String> = items
            .iter()
            .map(RawItem::bank_hash)
            .filter(|hash| !hash.is_empty())
            .collect();
        let now = now_ms();
        let Some(budget) = fallback_call_budget(input.deadline_at, now) else {
            eprintln!(
                "[search] reserva do banco sem prazo útil para {}; seguindo sem",
                meta.imdb_id
            );
            return items;
        };
        let deadline_at = now.saturating_add(budget.as_millis() as i64);
        let req = FallbackRequest {
            encoded: crate::request::encoded_for_internal(input.encoded.as_deref()),
            media_type: input.kind.clone(),
            imdb: meta.imdb_id.clone(),
            season: meta.season,
            episode: meta.episode,
            failed: live.failed_indexers(),
            suspect: live.suspect_indexers(),
            all_failed: live.all.failed(),
            live_hashes: live_hashes.clone(),
            deadline_at: Some(deadline_at),
        };
        let resp = match tokio::time::timeout(budget, routes.fallback(req)).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(err)) => {
                eprintln!("[search] reserva do banco indisponível; seguindo sem: {err}");
                return items;
            }
            Err(_) => {
                // A reserva é ACESSÓRIA: corta a chamada e devolve o lote vivo.
                // O cliente HTTP também recebe o `deadline_at`, mas o timeout
                // aqui é a garantia final (um dublê/rota pode ignorá-lo).
                eprintln!(
                    "[search] reserva do banco excedeu {}ms; seguindo sem",
                    budget.as_millis()
                );
                return items;
            }
        };
        if !resp.ok {
            return items;
        }
        let out = collect_fallback(&core_input(resp, meta, live, live_hashes));
        if out.injected() == 0 {
            return items;
        }
        eprintln!(
            "[search] reserva do banco: {} item(ns) para {}",
            out.injected(),
            meta.imdb_id
        );
        items.extend(out.items.iter().map(raw_item_from_fallback));
        items
    }

    /// Banco nativo: mesmas linhas/tetos/regras da rota Node, sem HTTP.
    /// Fail-open: banco desligado, sem store ou nada elegível → lista vazia.
    fn native_fallback_result(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
        items: &[RawItem],
        live: &LiveBatchState,
    ) -> Vec<FallbackItem> {
        if !self.config.magnet_bank_enabled || !self.config.magnet_bank_fallback_enabled {
            return Vec::new();
        }
        let Some(bank) = self.bank.as_ref() else {
            return Vec::new();
        };
        let failed = live.failed_indexers();
        let suspect = live.suspect_indexers();
        let all_failed = live.all.failed();
        if failed.is_empty() && !all_failed && suspect.is_empty() {
            return Vec::new();
        }
        let (per_indexer, global) = bank_limits(
            self.config.magnet_bank_fallback_max_per_indexer,
            self.config.magnet_bank_fallback_global_max,
        );
        let (read_limit, max_total) = bank_read_window(per_indexer, global);
        let targets = obra_targets(&input.kind, meta.season, meta.episode);
        let only_indexers: Option<Vec<String>> = if all_failed {
            None
        } else {
            let mut list: Vec<String> = failed.union(&suspect).cloned().collect();
            list.sort();
            Some(list)
        };
        let rows = bank.works_for_obra_many(
            &meta.imdb_id,
            &targets,
            read_limit,
            max_total,
            only_indexers.as_deref(),
        );
        let hashes: Vec<String> = {
            let mut seen = HashSet::new();
            rows.iter()
                .map(|row| row.hash.to_lowercase())
                .filter(|hash| !hash.is_empty() && seen.insert(hash.clone()))
                .collect()
        };
        let mut sources = bank.sources_for_many(&hashes);
        let index_only = &self.config.index_only_indexers;
        for list in sources.values_mut() {
            for source in list.iter_mut() {
                source.allowed = allowed_source_indexer(
                    &source.indexer,
                    &input.options,
                    index_only,
                    &self.config.selected_indexers,
                );
            }
        }
        let live_hashes: HashSet<String> = items
            .iter()
            .map(RawItem::bank_hash)
            .filter(|hash| !hash.is_empty())
            .collect();
        let mut works = Vec::with_capacity(rows.len());
        for row in rows {
            let magnet = row.magnet.map(|magnet| FallbackMagnet {
                hash: magnet.hash,
                uri: magnet.uri,
                title: magnet.title,
                size: magnet.size,
                is_br: magnet.is_br,
                dubbed: magnet.dubbed,
                quality: magnet.quality,
                seeders_max: magnet.seeders_max,
                seeders_last: magnet.seeders_last,
                last_seen: magnet.last_seen,
                lied: magnet.lied,
            });
            works.push(FallbackWork {
                hash: row.hash,
                passed_filter: row.passed_filter,
                last_seen: row.last_seen,
                magnet,
            });
        }
        let sources: BTreeMap<String, Vec<FallbackSource>> = sources
            .into_iter()
            .map(|(hash, list)| {
                (
                    hash,
                    list.into_iter()
                        .map(|source| FallbackSource {
                            indexer: source.indexer,
                            tracker: source.tracker,
                            last_seen: source.last_seen,
                            allowed: source.allowed,
                        })
                        .collect(),
                )
            })
            .collect();
        collect_fallback(&FallbackInput {
            enabled: true,
            fallback_enabled: true,
            imdb_id: meta.imdb_id.clone(),
            work_target: WorkTarget {
                season: meta.season,
                episode: meta.episode,
            },
            live_hashes,
            failed: failed.into_iter().collect(),
            suspect: suspect.into_iter().collect(),
            all_failed,
            per_indexer_max: per_indexer,
            global_max: global,
            br_indexers: self.config.pt_br_indexers.clone(),
            index_only_indexers: self.config.index_only_indexers.clone(),
            works,
            sources,
        })
        .items
    }
}
