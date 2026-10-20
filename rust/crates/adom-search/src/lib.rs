//! `adom-search` — embrião do ORQUESTRADOR NATIVO da rota `/stream`.
//!
//! Já fixa o que dá sem I/O de fonte (caminho, chave SWR, contrato JSON), o
//! **BUILD da lista** (`list_builder`) e a **orquestração** (`orchestrate`:
//! meta → collect → build, com SWR/`inFlight` opcionais). O glue HTTP das
//! rotas internas (`internal_client`) alimenta o orquestrador enquanto a rede
//! ainda mora no TypeScript.
//!
//! O que este crate **NÃO faz** (de propósito, nesta fatia):
//!
//! - **não abre o socket HTTP**: o handler mora no `adom-server` (corte
//!   `ROUTES_RUST=stream`); este crate só orquestra;
//! - **coleta default ainda é Node** (`POST /internal/search/collect`);
//!   opt-in `SOURCES_RUST=jackett|prowlarr|torrentio|bludv|mico` (CSV; exclusão
//!   mútua — jackett > prowlarr > torrentio > bludv > mico; sem composição
//!   multi-fonte nesta fatia) pluga collector nativo; metadados seguem nas
//!   rotas `/internal/search/*`;
//! - **não decide prazo sozinho**: recebe os milissegundos (Stremio × app) e
//!   no collect manda `deadline_at` absoluto;
//! - **não reproduz os defaults do operador**: `decode_user_config` aplica o
//!   overlay do segmento sobre um objeto VAZIO (sem `defaults()` do `.env`) e
//!   não abre a chave de debrid selada.
//!
//! Invariante que vale desde já: a config do usuário vem da URL (segmento
//! base64url) / do `encoded` no corpo das rotas internas — NUNCA do `.env`; e
//! o HOST nunca entra na chave de cache.
pub mod cache;
pub mod coalesce;
pub mod collection_window;
pub mod contract;
// O applyDebrid REAL: `DebridCheck` sobre os adaptadores do `adom-debrid`.
pub mod debrid_seam;
pub mod internal_client;
pub mod internal_types;
pub mod latest_writer;
pub mod list_builder;
// MONTAGEM do orquestrador do `/stream` (janela+build+SWR+fim+trace+fila
// tardia): aqui a coleta é injetada, o prazo corta a RESPOSTA e a busca continua em fundo.
pub mod orchestrator;
pub mod raw_item;
pub mod request;
// HMAC do `/resolve` (`debrid-pipeline-core.ts`): URL relativa de play.
pub mod resolve_url;

pub use cache::{
    has_playable_stream, relative_url, swr_lookup, to_cacheable_entry, MemorySwrStore, StoreHit,
    StreamsEntry, SwrLookup, SwrStore, STREAM_STALE_GRACE_SECONDS,
};
pub use coalesce::InFlight;
// Porte de `src/utils/latest-writer.ts`: parcial na resposta, tardio mescla.
pub use latest_writer::{CommitKind, LatestWriter};
// BUILD da lista (`stream-builder*`): dos itens crus à lista final.
pub use list_builder::{
    apply_notice_origin, build_stream_list, seed_floor_for, AudioAudit, BuildContext, BuildOptions,
    BuiltList, BuiltStream, DebridAnswer, DebridCheck, WorkHint,
};
// Costura real com os adaptadores de debrid + reserva interna do Node.
pub use debrid_seam::{answer_of, AdapterDebridCheck, FallbackCheck, NodeInternalFallback};
pub use raw_item::RawItem;
// Store do `raw:v1` (o gateway injeta o mesmo `cache.db` do Node no coletor
// BLUDV nativo); a sombra nunca o recebe.
pub use adom_sources::{MemoryRawStore, RawStore};

pub use collection_window::{
    jump_deadline, BatchMeta, CollectBudgets, CollectTask, CollectWindow, CollectWindowOptions,
};
pub use contract::{BehaviorHints, StreamItem, StreamResponse};
pub use internal_client::{InternalSearchClient, DEFAULT_BASE, DEFAULT_TIMEOUT};
pub use internal_types::{
    BreakerSnapshot, CollectRequest, CollectResponse, EffectEntry, EffectsRequest, EffectsResponse,
    FallbackMagnetWire, FallbackRequest, FallbackResponse, FallbackSourceWire, FallbackWorkWire,
    IndexWriteRequest, IndexWriteResponse, LiveSnapshot, MetaRequest, MetaResponse, ReleaseEntry,
    StateRequest, StateResponse, TaskScope,
};
pub use orchestrator::{Orchestrator, OrchestratorConfig, StreamRequest};
pub use raw_item::raw_item_from_value;
pub use request::{
    decode_user_config, encoded_for_internal, parse_stream_path, reply_deadline_ms,
    request_cache_key, StreamTarget, DEFAULT_CONFIG_SEGMENT,
};
pub use resolve_url::{
    debrid_api_key_from_encoded, effective_resolve_secret, encode_uri_component,
    parse_resolve_path, resolve_play_from, resolve_secret_for, verify_resolve_play, ResolvePlay,
    ResolveSigner, ResolveVerify,
};

/// Trava ÚNICA dos testes que tocam env dentro do crate (bases de API em
/// loopback, amostra da sombra). Sem ela, módulos de teste diferentes sujam a
/// env uns dos outros.
#[cfg(test)]
pub(crate) mod test_env {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    pub fn lock() -> MutexGuard<'static, ()> {
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }
}
