//! `adom-search` — embrião do ORQUESTRADOR NATIVO da rota `/stream`.
//!
//! Nesta fatia (F1.1) o crate guarda **só o que dá para fixar sem I/O**: como a
//! requisição do Stremio é lida (caminho e config na URL), qual é a chave de
//! cache da busca e qual é a forma EXATA do corpo JSON da resposta. O contrato
//! que ele antecipa está em `docs/rust-stream-contract.md`.
//!
//! O que este crate **NÃO faz** (de propósito, nesta fatia):
//!
//! - **não monta lista**: filtro de título/episódio, ranking, cotas, debrid
//!   (`applyDebrid`), aviso de lista vazia e `applyNoticeOrigin` continuam no
//!   TypeScript;
//! - **não faz I/O**: Cinemeta, TMDB, Jackett, Prowlarr, Torrentio, BLUDV,
//!   Mico, debrid, banco de magnets e cache não são tocados aqui;
//! - **não abre rota**: nenhum handler `/stream` nativo existe, o
//!   `adom-server` não depende deste crate e o `/stream` continua 100% Node;
//! - **não decide prazo nem cache sozinho**: recebe os dois milissegundos
//!   (Stremio × app Power Movie) e devolve a escolha; `cacheMaxAge` só carrega
//!   o número que o Node calculou;
//! - **não reproduz os defaults do operador**: `decode_user_config` aplica o
//!   overlay do segmento sobre um objeto VAZIO (sem `defaults()` do `.env`) e
//!   não abre a chave de debrid selada (o `RESOLVE_SECRET` não existe aqui).
//!   Quem chamar precisa passar os defaults reais para `adom_core::decode_config`
//!   quando a integração chegar.
//!
//! Invariante que vale desde já: a config do usuário vem da URL (segmento
//! base64url) e NUNCA do `.env`; e o HOST nunca entra na chave de cache.
pub mod cache;
pub mod coalesce;
pub mod collection_window;
pub mod contract;
pub mod request;

pub use cache::{
    has_playable_stream, relative_url, swr_lookup, to_cacheable_entry, MemorySwrStore, StoreHit,
    StreamsEntry, SwrLookup, SwrStore, MAX_TTL_SECONDS, STREAM_STALE_GRACE_SECONDS,
};
pub use coalesce::InFlight;

pub use collection_window::{
    jump_deadline, BatchMeta, CollectBudgets, CollectTask, CollectWindow, CollectWindowOptions,
};
pub use contract::{BehaviorHints, StreamItem, StreamResponse};
pub use request::{
    decode_user_config, parse_stream_path, reply_deadline_ms, request_cache_key, StreamTarget,
};
