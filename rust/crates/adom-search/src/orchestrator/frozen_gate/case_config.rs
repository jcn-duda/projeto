//! Config do operador e as bordas congeladas que o replay injeta.

use adom_core::StreamDisplayConfig;
use serde_json::Value;

use crate::list_builder::BuildOptions;

use super::case::FrozenCase;
use super::debrid::FrozenDebridFactory;
use super::helpers::{bool_of, f64_of, i64_of, string_list, u64_of};
use super::routes::FrozenRoutes;
use crate::orchestrator::config::{build_options_from, OrchestratorConfig};

impl FrozenCase {
    #[allow(clippy::field_reassign_with_default)] // harness de teste: espelha o config do operador campo a campo
    pub(super) fn config(&self) -> OrchestratorConfig {
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

    pub(super) fn routes(self) -> FrozenRoutes {
        FrozenRoutes {
            meta: self.meta,
            collect: self.collect,
            fallback: self.fallback,
            pt_br: string_list(&self.operator["jackett"]["ptBr"]),
        }
    }

    pub(super) fn debrid(&self) -> FrozenDebridFactory {
        FrozenDebridFactory {
            call: self.debrid.clone(),
        }
    }
}
