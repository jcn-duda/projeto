//! Buscas que não seguem o `/?s=` + seleção + post do fluxo comum
//! (`ResolverProfile::search_items`): Apache (sessão + token), HDR (varredura
//! da listagem do catálogo), Vaca (AJAX JSON + páginas de filme/temporada) e
//! TorrentGalaxy (busca no PATH, com o magnet que só existe no post de
//! detalhe — por isso o fluxo dele é lazy).

pub mod apache;
pub mod hdr;
pub mod torrentgalaxy;
pub mod vaca;
