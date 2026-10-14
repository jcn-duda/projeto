//! Reexporta as FORMAS de página do VacaTorrent que o raspador usa.
//!
//! O corpo mora em `crate::br_core::vaca::formas` (port fiel de
//! `resolvers/profiles/vacatorrent-shapes.ts`), compartilhado com o resolver.
//! Este arquivo só mantém o endereço histórico `profile_parsers::*` e registra o
//! que mudou ao adotar a versão fiel — cada item com a linha do TS:
//!
//! - `extract_movie_links`/`series_season_internal_url` sem `baseUrl` devolvem
//!   `None`, não o href cru (`vacatorrent-shapes.ts:16,29,33,37,39` — o
//!   `try { new URL(href, baseUrl) } catch { return null }`).
//! - `decode_data_u` é tolerante como `Buffer.from(..).toString('utf8')` (`:23`),
//!   não `String::from_utf8` estrito.
//! - `parse_season_internal` lê atributo com o `attribute` de `text.ts:97-105`
//!   (sem espaço em volta do `=`) e testa classe/href COM fronteira de palavra
//!   (`:59-60`): `sa-card` não colide com `bl-sa-card-x`, `batch` não casa com
//!   "imbatch".
//! - `repair_mangled_entities` ganha as regras `#170`/`#186` (`text.ts:31-32`).
//! - `normalize_episode_markup` fecha com o MESMO elemento (`</\1>`, `:117`) e
//!   injeta `"Episódio $2 "` (`:120`).
//! - `extract_batch_title`/`parse_season_internal` passam pelo `stripTags` com o
//!   `decodeEntities` de `text.ts` (`:5,8`), não pela tabela grande.

pub use crate::br_core::vaca::{
    decode_data_u, extract_batch_title, extract_movie_links, filter_season_cards,
    is_vaca_protector_host, is_watch_anchor, normalize_batch_title, normalize_episode_markup,
    parse_season_internal, repair_mangled_entities, series_season_internal_url,
};
