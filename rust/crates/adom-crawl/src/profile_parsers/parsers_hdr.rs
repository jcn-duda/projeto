//! HDRTorrents (`resolvers/profiles/hdrtorrents-parsers.ts`): as linhas
//! `.download-row` com magnets diretos e o tamanho da ficha técnica. Autoridade
//! TS única deste arquivo.
//!
//! O núcleo do parse mora em `br_core::hdr` (compartilhado com o resolver);
//! este arquivo só reexporta a função pública.

/// Parseia linhas `.download-row` com magnets diretos do HDRTorrents.
/// Delega ao núcleo compartilhado (`br_core::hdr::parse_content_magnets`).
use crate::profile_parsers::ResolverLink;

pub fn parse_content_magnets(html: &str, _base_url: Option<&str>) -> Vec<ResolverLink> {
    crate::br_core::hdr::parse_content_magnets(html)
}
