//! Buscas que não seguem o `/?s=` + seleção + post do fluxo comum
//! (`ResolverProfile::search_items`): Apache (sessão + token), HDR (varredura
//! da listagem do catálogo) e Vaca (AJAX JSON + páginas de filme/temporada).

pub mod apache;
pub mod hdr;
pub mod vaca;
