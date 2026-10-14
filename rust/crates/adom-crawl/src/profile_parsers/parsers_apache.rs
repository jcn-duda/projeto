//! ApacheTorrent (`resolvers/profiles/apachetorrent-parsers.ts`): os blocos
//! `div.download-block` viram links. Autoridade TS única deste arquivo.
//!
//! O núcleo do parse mora em `br_core::apache` (compartilhado com o resolver);
//! este arquivo só reexporta a função pública.

/// Parseia blocos `div.download-block` do ApacheTorrent.
/// Delega ao núcleo compartilhado (`br_core::apache::parse_post_magnets`).
use crate::profile_parsers::ResolverLink;

pub fn parse_post_magnets(html: &str, base_url: Option<&str>) -> Vec<ResolverLink> {
    // O `base_url` do raspador corresponde ao `post_url` do resolver: a URL
    // do post é usada para resolver hrefs relativos.
    let post_url = base_url.unwrap_or("");
    crate::br_core::apache::parse_post_magnets(html, post_url)
}
