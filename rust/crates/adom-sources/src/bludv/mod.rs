//! Cliente do scraper BLUDV (Fase B — busca por título WordPress).
//!
//! Espelha `src/providers/bludv.ts` no essencial:
//!
//! - `GET {base}/?s=` → posts → links legado → protetor → magnet;
//! - falha de rede → `[]` sem panic (o caminho vivo usa [`BludvOutcome`] para
//!   distinguir ok/empty/failed);
//! - gate de anúncio detectado e pulado no caminho de busca (solve longo
//!   nunca entra na resposta; cache/prefetch de gate fica para fatia futura);
//! - redirect `follow` como o `fetch` do TS, mas com `is_safe_download_url` em
//!   CADA hop (o reqwest não valida o destino sozinho);
//! - `is_br: true`, `seeders: 1`, `tracker: "BLUDV"` (o `_indexer` do stream
//!   nasce desse rótulo e vira `bludv` no build, como no Node);
//! - título/qualidade/fonte/áudio pelo contexto do botão
//!   (`releaseTitle`/`createLinkCollector`);
//! - `dubbedOnly` recebido por [`BludvSearchOpts`] (o default do operador é
//!   aplicado na request, `BLUDV_DUBBED_ONLY=true` no Node);
//! - concorrência limitada por `BLUDV_CONCURRENCY` (default 6) em posts e em
//!   links, preservando a ordem do documento.
//!
//! `raw:v1` (`{items}` por query) só é lido/gravado no caminho VIVO; a sombra
//! read-only passa `read_only: true` e não tem efeitos (mesmo contrato do
//! `bludv.search(query, { readOnly })` do Node).
//!
//! Não reusa o binário `adom-resolvers` via HTTP nesta fatia (cliente fino
//! próprio). Parsing de posts/links é local; o resolvedor Jackett Cardigann
//! continua separado.

mod client;
mod config;
mod parse;
mod title;
mod types;

pub use client::BludvClient;
pub use config::{
    BludvConfig, BLUDV_DEFAULT_TIMEOUT_MS, BLUDV_DEFAULT_URL, BLUDV_RAW_EMPTY_TTL,
    BLUDV_RAW_MAX_ITEMS, BLUDV_RAW_TTL_BR, BLUDV_USER_AGENT,
};
pub use parse::{
    clean_post_title, extract_magnet, is_gate_url, is_valid_magnet_uri, parse_download_links,
    parse_posts, parse_size, release_title,
};
pub use title::{audio_from_anchor, audio_from_segment, normalize_quality, normalize_source};
pub use types::{BludvDownloadLink, BludvOutcome, BludvPost, BludvRawItem, BludvSearchOpts};
