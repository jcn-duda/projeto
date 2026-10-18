//! `adom-search` — embrião do ORQUESTRADOR NATIVO da rota `/stream`.
//!
//! Já fixa o que dá sem I/O de fonte (caminho, chave SWR, contrato JSON) e o
//! **BUILD da lista** (`list_builder`: filtro → ranking → cotas → aviso). O
//! glue HTTP das rotas internas do Node (`internal_client`) é o próximo
//! degrau: meta/state/collect/index-write/effects em loopback enquanto a rede
//! ainda mora no TypeScript.
//!
//! O que este crate **NÃO faz** (de propósito, nesta fatia):
//!
//! - **não abre rota `/stream`**: nenhum handler nativo; o `adom-server` não
//!   depende deste crate e o `/stream` continua 100% Node;
//! - **não fala com Jackett/Cinemeta/TMDB direto**: a coleta e os metadados
//!   passam pelas rotas `/internal/search/*` do Node;
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
pub mod raw_item;
pub mod request;

pub use cache::{
    has_playable_stream, relative_url, swr_lookup, to_cacheable_entry, MemorySwrStore, StoreHit,
    StreamsEntry, SwrLookup, SwrStore, MAX_TTL_SECONDS, STREAM_STALE_GRACE_SECONDS,
};
pub use coalesce::InFlight;
// Porte de `src/utils/latest-writer.ts`: parcial na resposta, tardio mescla.
pub use latest_writer::{CommitKind, LatestWriter};
// BUILD da lista (`stream-builder*`): dos itens crus à lista final.
pub use list_builder::{
    apply_notice_origin, build_stream_list, seed_floor_for, BuildContext, BuildOptions, BuiltList,
    BuiltStream, DebridAnswer, DebridCheck, WorkHint,
};
// Costura real com os adaptadores de debrid + reserva interna do Node.
pub use debrid_seam::{answer_of, AdapterDebridCheck, FallbackCheck, NodeInternalFallback};
pub use raw_item::RawItem;

pub use collection_window::{
    jump_deadline, BatchMeta, CollectBudgets, CollectTask, CollectWindow, CollectWindowOptions,
};
pub use contract::{BehaviorHints, StreamItem, StreamResponse};
pub use internal_client::{InternalSearchClient, DEFAULT_BASE, DEFAULT_TIMEOUT};
pub use internal_types::{
    BreakerSnapshot, CollectRequest, CollectResponse, EffectEntry, EffectsRequest, EffectsResponse,
    IndexWriteRequest, IndexWriteResponse, LiveSnapshot, MetaRequest, MetaResponse, ReleaseEntry,
    StateRequest, StateResponse, TaskScope,
};
pub use request::{
    decode_user_config, parse_stream_path, reply_deadline_ms, request_cache_key, StreamTarget,
};
