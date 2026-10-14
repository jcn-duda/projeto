//! Reexporta as FORMAS de página do VacaTorrent usadas pelo resolver.
//!
//! O corpo mora em `crate::common::vaca` (`adom-crawl/src/br_core/vaca_formas.rs`),
//! que é o port fiel de `resolvers/profiles/vacatorrent-shapes.ts` — o MESMO que o
//! raspador consome. Este arquivo já guardou uma segunda cópia dessas regras; a
//! cópia é o bug que a fase 1 elimina, porque as duas divergem em silêncio.
//!
//! Detalhe do decoder: `resolvers/profiles/vacatorrent-shapes.ts:5,8` importa
//! `stripTags`/`decodeEntities` de `../text.js`, a tabela de 15 nomes
//! (`resolvers/text.ts:1-17`, com `nbsp` = espaço comum) — NÃO o
//! `adom_core::decode_entities` (tabela grande de `src/utils/title-normalization.ts`),
//! cujo `&ordf;` divergiria. Por isso `decode_entities`/`strip_tags` saem daqui.

pub use crate::common::vaca::{
    decode_data_u, extract_batch_title, extract_movie_links, filter_season_cards, is_watch_anchor,
    normalize_batch_title, normalize_episode_markup, parse_season_internal,
    repair_mangled_entities, series_season_internal_url, VacaSeasonCard,
};

// `search.rs` monta a entrada da busca AJAX com estes três; `pub(crate)` basta e
// evita publicar no crate uma API que só existe para o site da vaca.
pub(crate) use crate::common::vaca::{decode_entities, resolve_url, strip_tags};
