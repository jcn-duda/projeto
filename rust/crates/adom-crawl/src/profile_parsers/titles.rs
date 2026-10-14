//! Ponte do raspador para os TÍTULOS fiéis do núcleo BR.
//!
//! Antes este arquivo mantinha a terceira cópia das regras de título (limpeza
//! combinada em uma regex, decoder da tabela grande e faixa de episódio no
//! lugar do `episodeOf` do vaca). O corpo agora é `crate::br_core::release` e
//! `crate::br_core::vaca`, consumidos também pelo resolver.
//!
//! Autoridade do decoder em todo este arquivo: `resolvers/release-format.ts:2`
//! e `resolvers/profiles/vacatorrent-parsers.ts:2` importam `decodeEntities` de
//! `./text.js` — a tabela de 15 nomes (`resolvers/text.ts:1-17`, com `nbsp` =
//! espaço comum), NÃO o `adom_core::decode_entities` (tabela grande de
//! `src/utils/title-normalization.ts`).

use crate::br_core::page::SitePost;
use crate::br_core::vaca::vaca_release_title;
use crate::profile_parsers::ResolverLink;

// `cleanPostTitle` do núcleo (`release-format.ts:43-59`), uma cópia só. A
// variante local deste arquivo estava morta e era divergente: usava a tabela
// grande e `\b`/`\d` Unicode, e aparava só `trim_matches` em vez dos passos
// LEADING/TRAILING_SEPS do TS.
pub use crate::br_core::release::clean_post_title;

// `cleanMarkTitle` do vaca (`vacatorrent-parsers.ts:333-342`): cinco `.replace()`
// SEQUENCIAIS (`Vaca Torrent`, `Download`, `Baixar`, `ver online`,
// `dublado|dublada|legendado|legendada\b`). A cópia local tinha isso fundido numa
// única alternância, o que muda o resultado quando um marcador aparece depois de
// outro ter sido cortado.
pub use crate::br_core::vaca::clean_mark_title;

/// Título da release no caminho do raspador (`page_parser/build.rs`): o post é
/// identificado pelo título e pelo ano, não por um `SitePost` materializado.
///
/// Regras aplicadas: as do `releaseTitle` do vaca
/// (`vacatorrent-parsers.ts:344-357`) — `titleOf` com `realTitle` falsy-aware
/// (`:347`), `seasonOf`/`episodeOf`/`yearOf` só sem título real (`:352-356`) e
/// `audioTagOf` com DUAL (`:348-351`). O `episodeOf` do vaca NÃO emite faixa:
/// `` `E${String(link.episode).padStart(2,'0')}` `` (`:355`), enquanto o default
/// do núcleo (`release-format.ts:99-101`) usaria `episodeTag(episode,
/// episodeLast)` → "E01-E03".
pub fn release_title(
    post_title: &str,
    post_year: Option<u32>,
    link: &ResolverLink,
    index: Option<usize>,
) -> String {
    let post = SitePost {
        title: post_title.to_string(),
        url: String::new(),
        // `yearOf` do TS exige `post?.year` truthy (`:356`): ano 0 é ausente.
        year: post_year.filter(|y| *y != 0),
        ..Default::default()
    };
    vaca_release_title(&post, link, index)
}
