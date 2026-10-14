//! Núcleo compartilhado do VacaTorrent (`resolvers/profiles/vacatorrent-*.ts`).
//!
//! Aqui mora a implementação FIEL dos botões e dos títulos da vaca, consumida
//! pelos dois lados: o resolver (`adom-resolvers/src/sites/vacatorrent*.rs`, via
//! `crate::common::vaca`) e o raspador (`adom-crawl/src/profile_parsers/*`).
//! Antes havia duas cópias de cada regra e o raspador ficou para trás: sem o
//! `throw` do desempate, sem o passo de episódio na âncora "Veja Online", com
//! regex combinada no lugar dos cinco passos de `cleanMarkTitle` e com o decoder
//! errado. A versão fiel é uma só — a que o oráculo TS já media no resolver.
//!
//! As formas de página (movie-links, season-internal, cards, batch, markup de
//! episódio) estão em `vaca_formas.rs`, declarado abaixo por `#[path]` para não
//! tocar `br_core/mod.rs` e para respeitar o teto de 400 linhas por arquivo.

#[path = "vaca_formas.rs"]
mod formas;
pub use formas::*;

use std::sync::LazyLock;

use fancy_regex::{Captures, Regex as FancyRegex};
use regex::Regex;

use super::collector::{parse_download_links, CollectorHooks, Resolved, Step};
use super::episode::{EpisodeRules, EpisodeScope, EpisodeStepConfig, PackMatchAll};
use super::page::SitePost;
use super::release::{release_title, ReleaseTitleConfig, FB};
use super::rules::{
    compile, normalize_quality, normalize_source_with, resolve_protector_href, VACA_SOURCE_MATCH,
};
// O `decodeEntities`/`stripTags` do profile da vaca é o de `resolvers/text.ts`
// (`vacatorrent-parsers.ts:2`, `vacatorrent-shapes.ts:5,8`) — tabela de 15 nomes,
// `nbsp` = espaço comum. Publicado daqui para o resolver consumir O MESMO decoder
// em vez de manter a terceira cópia da tabela (`sites/vacatorrent_shapes.rs`).
pub use super::text::{decode_entities, strip_tags};
use crate::profile_parsers::ResolverLink;
// A régua de protetor do site (base + `systemtech.space`, `vacatorrent-parsers.ts:55-60`)
// já mora no `shared` do crate, com testes; o núcleo consome em vez de reescrever.
pub use crate::shared::protector_suffixes::is_vaca_protector_host;

/// `packPattern` do vaca (`vacatorrent-parsers.ts:88`): `\bbatch\b` e `\bPACK\b`
/// além dos rótulos padrão — o padrão do núcleo não tem nenhum dos dois.
const VACA_PACK: &str = r"(?i){B}(?:TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA|PACK\s+COMPLETO|PACOTE\s+COMPLETO|{B}PACK{B}|{B}BATCH{B}){B}";
/// `rangePattern` do vaca (`:89`): separador `[.\-s]*`, não `[.\s-]*`.
const VACA_RANGE: &str = r"(?i)(?:EPIS[ÓO]DIOS?|EP|CAP[ÍI]TULOS?|CAP|E)[.\-s]*[0-9]{1,3}[.\s-]*(?:A|AO|[-–—])[.\s-]*[0-9]{1,3}{B}";

/// `episodeRules` (`:87-91`) — também o `extractEpisode` usado pelo passo.
static EPISODES: LazyLock<EpisodeRules> =
    LazyLock::new(|| EpisodeRules::new(VACA_PACK, VACA_RANGE));

/// `anchorRe` (`:296`): `/<a\b([^>]*)>([\s\S]*?)<\/a>/gi`.
static ANCHOR: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(r"(?i)<a{FB}([^>]*)>([\s\S]*?)</a>")).expect("âncora do vaca")
});

/// `classifyAudio` (`:79-84`): PT com idioma estrangeiro é `dual`; só PT é
/// `dublado`; só estrangeiro é `legendado`. É o classificador PRÓPRIO da vaca,
/// não o `audioFromSegment` genérico do núcleo.
pub fn classify_audio(context: &str) -> Option<String> {
    let text = context.to_uppercase();
    let has_pt = AUDIO_PT.is_match(&text);
    let has_foreign = AUDIO_FOREIGN.is_match(&text);
    let label = match (has_pt, has_foreign) {
        (true, true) => "dual",
        (true, false) => "dublado",
        (false, true) => "legendado",
        (false, false) => return None,
    };
    Some(label.to_string())
}

static AUDIO_PT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("PORTUGU[ÊE]S|PORTUGUES").expect("regex áudio pt"));
static AUDIO_FOREIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("INGL[ÊE]S|INGLES|ESPANHOL|JAPON[ÊE]S|COREANO|LEGENDAD|ORIGINAL")
        .expect("regex áudio estrangeiro")
});

/// `VacaParseDownloadLinksOptions` + as `options` do `parseDownloadLinks`
/// (`:281-286,316`): temporada e título real do batch entram em todo botão.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VacaParseOptions {
    pub season: Option<u32>,
    pub real_title: Option<String>,
}

struct VacaHooks<'a> {
    opts: &'a VacaParseOptions,
    /// `options.isProtectorHost` (`:289`): o raspador pode injetar outra régua;
    /// `None` é a régua default do profile (base + `systemtech.space`).
    checker: Option<&'a dyn Fn(&str) -> bool>,
}

impl VacaHooks<'_> {
    fn protector_checker(&self) -> &dyn Fn(&str) -> bool {
        let default: &dyn Fn(&str) -> bool = &is_vaca_protector_host;
        self.checker.unwrap_or(default)
    }
}

impl CollectorHooks for VacaHooks<'_> {
    fn anchor_re(&self) -> &FancyRegex {
        &ANCHOR
    }
    fn resolve_href(
        &self,
        caps: &Captures<'_, str>,
        _html: &str,
        base_url: Option<&str>,
    ) -> Resolved {
        let attrs = caps.get(1).map_or("", |m| m.as_str());
        let anchor_text = strip_tags(caps.get(2).map_or("", |m| m.as_str()));
        // "Veja Online"/player nunca é botão: skip SEM avançar o cursor
        // (`vacatorrent-parsers.ts:298-304`), o que deixa o número do bloco no
        // segmento do botão de download seguinte.
        if is_watch_anchor(attrs, &anchor_text) {
            return Resolved::Skip { advance: false };
        }
        resolve_protector_href(attrs, base_url, self.protector_checker())
    }
    fn anchor_text_of(&self, caps: &Captures<'_, str>) -> String {
        strip_tags(caps.get(2).map_or("", |m| m.as_str()))
    }
    fn strip_tags(&self, value: &str) -> String {
        strip_tags(value)
    }
    fn initial_audio(&self) -> Option<String> {
        None
    }
    fn audio_from_segment(&self, segment: &str) -> Option<String> {
        classify_audio(segment)
    }
    fn audio_from_anchor(&self, anchor_text: &str) -> Option<String> {
        classify_audio(anchor_text)
    }
    /// `episodeStep` (`:92-100`): escopo `anchor-writes`, `tieBreak: true` e
    /// `packMatchAll` = o pack CRU (sem `/g`), que no JS faz o `matchAll` lançar
    /// `TypeError` — preservado como `Err` (`release-rules.ts:222-228`).
    fn episode_step(
        &self,
        segment: &str,
        anchor: &str,
        state: Option<u32>,
    ) -> Result<Step, String> {
        let rules = &*EPISODES;
        EpisodeStepConfig {
            scope: EpisodeScope::AnchorWrites,
            pack: &rules.pack,
            range: Some(&rules.range),
            ep: &rules.episode,
            extract: Some(rules),
            pack_match_all: Some(PackMatchAll::Throws),
            tie_break: true,
            ep_range_group: None,
        }
        .step(segment, anchor, state)
    }
    fn quality(&self, context: &str) -> Option<u32> {
        normalize_quality(context)
    }
    /// `createSourceRules({ matchPattern: VACA_SOURCE_MATCH_RE })` (`:77`).
    fn source(&self, context: &str) -> Option<String> {
        normalize_source_with(context, &VACA_SOURCE_MATCH)
    }
    /// `decodeHtml: decode` (`:309`) com o `decodeEntities` de `text.ts` (`:2`).
    fn decode_html(&self, html: &str) -> String {
        decode_entities(html)
    }
    /// `extrasOf` (`:316`).
    fn extras(&self, link: &mut ResolverLink) {
        link.season = self.opts.season;
        link.real_title = self.opts.real_title.clone();
    }
}

/// `parseDownloadLinks(html, baseUrl, options)` (`:319-323`): normaliza o markup
/// por episódio e roda o coletor. `Err` é o `throw` do desempate que o TS deixa
/// subir — o post inteiro não produz botões, não uma lista parcial.
pub fn post_links(
    html: &str,
    base_url: Option<&str>,
    opts: &VacaParseOptions,
    checker: Option<&dyn Fn(&str) -> bool>,
) -> Result<Vec<ResolverLink>, String> {
    let normalized = normalize_episode_markup(html);
    parse_download_links(&VacaHooks { opts, checker }, &normalized, base_url)
}

// ─── título da release (`vacatorrent-parsers.ts:333-357`) ────────────────

/// Os CINCO `.replace()` sequenciais do `cleanMarkTitle` (`:335-339`), na ordem
/// do TS. Não é uma alternância única: cada passo roda sobre a saída do
/// anterior, então "Vaca Torrent Download" perde os dois, um por vez, e um
/// "Download" que só apareceu depois de cortar "Vaca Torrent" ainda é cortado.
static CLEAN_STEPS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)\s*Vaca\s+Torrent\s*",
        r"(?i)\s*Download\s*",
        r"(?i)\s*Baixar\s*",
        r"(?i)\s*ver\s+online\s*",
        r"(?i)\s*(?:dublado|dublada|legendado|legendada){B}",
    ]
    .iter()
    .map(|p| compile(p))
    .collect()
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("regex espaços"));

pub fn clean_mark_title(title: &str) -> String {
    let mut out = decode_entities(title);
    for re in CLEAN_STEPS.iter() {
        out = re.replace_all(&out, " ").into_owned();
    }
    SPACES.replace_all(&out, " ").trim().to_string()
}

fn has_real_title(link: &ResolverLink) -> bool {
    link.real_title.as_deref().is_some_and(|t| !t.is_empty())
}

/// `titleOf` (`:346-347`): `link.realTitle || post.title || ''` — título real
/// VAZIO é falsy e cai no título do post.
fn title_of(post: &SitePost, link: &ResolverLink) -> String {
    match link.real_title.as_deref().filter(|t| !t.is_empty()) {
        Some(real) => real.to_string(),
        None => post.title.clone(),
    }
}

/// `seasonOf`/`episodeOf`/`yearOf` (`:352-356`): os três são guardados por
/// `!link.realTitle`. O `episodeOf` da vaca NÃO emite faixa — é
/// `` `E${String(link.episode).padStart(2,'0')}` `` — diferente do default do
/// núcleo, que usa `episodeTag(episode, episodeLast)`.
fn season_of(_post: &SitePost, link: &ResolverLink) -> String {
    match link.season.filter(|_| !has_real_title(link)) {
        Some(s) => format!("S{s:02}"),
        None => String::new(),
    }
}

fn episode_of(_post: &SitePost, link: &ResolverLink) -> String {
    match link.episode.filter(|_| !has_real_title(link)) {
        Some(e) => format!("E{e:02}"),
        None => String::new(),
    }
}

fn year_of(post: &SitePost, link: &ResolverLink) -> String {
    match post.year.filter(|y| *y != 0 && !has_real_title(link)) {
        Some(y) => format!(" ({y})"),
        None => String::new(),
    }
}

/// `audioTagOf` (`:348-351`): `dual` vira DUAL, que o default do núcleo não tem.
fn audio_tag_of(link: &ResolverLink) -> Option<String> {
    match link.audio.as_deref() {
        Some("dublado") => Some("DUBLADO".into()),
        Some("dual") => Some("DUAL".into()),
        Some("legendado") => Some("LEGENDADO".into()),
        _ => None,
    }
}

/// `releaseTitle = createReleaseTitle({...})` (`:344-357`).
pub const VACA_TITLE: ReleaseTitleConfig = ReleaseTitleConfig {
    title_of: Some(title_of),
    audio_tag_of: Some(audio_tag_of),
    season_of: Some(season_of),
    episode_of: Some(episode_of),
    year_of: Some(year_of),
    ..ReleaseTitleConfig::new(clean_mark_title)
};

/// Título da release do vaca a partir de um post já resolvido.
pub fn vaca_release_title(post: &SitePost, link: &ResolverLink, index: Option<usize>) -> String {
    release_title(&VACA_TITLE, post, link, index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> VacaParseOptions {
        VacaParseOptions::default()
    }

    /// Autoridade do `throw`: `packMatchAll: episodeRules.packPattern` cru
    /// (`vacatorrent-parsers.ts:98`) + `release-rules.ts:222-228`. O segmento tem
    /// marcador de episódio E pack → desempate → `TypeError`, e num botão emitido
    /// isso derruba o post inteiro (lista vazia, não lista parcial).
    #[test]
    fn empate_de_seletor_lanca_como_no_ts() {
        let html = r#"<div>EPISÓDIO 3 TEMPORADA COMPLETA</div>
            <a href="https://systemtech.space/enc/go.php?id=1">Download 1080p (2 GB)</a>"#;
        let got = post_links(html, Some("https://vaca.example/x/"), &opts(), None);
        assert!(
            matches!(&got, Err(e) if e.contains("matchAll")),
            "esperava o TypeError do matchAll, veio {got:?}"
        );
    }

    /// Autoridade do passo na âncora transparente: `link-collector.ts:70-89` roda
    /// o `episodeStep` mesmo no `{skip:true}` SEM `advance`, e
    /// `release-rules.ts:238` zera o estado quando a âncora é pack. O botão de
    /// download seguinte vem SEM número; o raspador antigo carregava o 3.
    #[test]
    fn ancora_transparente_escreve_no_estado() {
        let html = r#"<a href="https://systemtech.space/enc/go.php?id=a">Episódio 3 Download 1080p (2 GB)</a>
            <a class="ml-btn-video" href="https://systemtech.space/player.php">TEMPORADA COMPLETA Veja Online</a>
            <a href="https://systemtech.space/enc/go.php?id=b">Download 1080p (2 GB)</a>"#;
        let links = post_links(html, Some("https://vaca.example/x/"), &opts(), None).unwrap();
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].episode, Some(3));
        assert_eq!(
            links[1].episode, None,
            "o pack da âncora de assistir zerou o estado"
        );
    }

    /// `vacatorrent-parsers.ts:333-342`: são CINCO `.replace()` sequenciais, cada
    /// um sobre a saída do anterior, NÃO uma alternância única; e o passo 5
    /// (`:339`) não tem `\b` ANTES do grupo. Valores medidos no oráculo TS.
    #[test]
    fn clean_mark_title_segue_os_cinco_passos() {
        assert_eq!(
            clean_mark_title("Expresso do Amanhã Vaca Torrent Download 1080p Dublado"),
            "Expresso do Amanhã 1080p"
        );
        // Passo sequencial: cortar "Vaca Torrent" expõe o "Download" do meio.
        assert_eq!(clean_mark_title("A Vaca Torrent Download B"), "A B");
        // Sem `\b` antes do áudio (linha 339 do TS): "XDublado" perde "Dublado".
        assert_eq!(clean_mark_title("Filme XDublado"), "Filme X");
        // Decoder do profile (`:2` importa `decodeEntities` de `../text.js`):
        // `&ordf;` não está nos 15 nomes e fica INTACTO — a tabela grande de
        // `src/utils/title-normalization.ts:57` daria "2ª Temporada".
        assert_eq!(
            clean_mark_title("Serie 2&ordf; Temporada"),
            "Serie 2&ordf; Temporada"
        );
    }

    /// `vacatorrent-parsers.ts:354-355`: `episodeOf` da vaca NUNCA emite faixa,
    /// mesmo com `episodeLast` — diferente do `episodeTag` do núcleo.
    #[test]
    fn episodio_do_vaca_nao_emite_faixa() {
        let post = SitePost {
            title: "Outer Banks".into(),
            url: "https://vaca.example/x/".into(),
            year: Some(2020),
            ..Default::default()
        };
        let link = ResolverLink {
            url: "magnet:?x".into(),
            episode: Some(1),
            episode_last: Some(3),
            season: Some(2),
            ..Default::default()
        };
        assert_eq!(
            vaca_release_title(&post, &link, None),
            "Outer Banks (2020) S02E01"
        );
    }

    /// Base + extra do site (`protector.ts:9-15` + `vacatorrent-parsers.ts:57`),
    /// e `t.co` é `ASSERT_ONLY_SUFFIXES` (`:51`): vale como salto, nunca botão.
    #[test]
    fn protetores_do_site_sao_a_base_mais_systemtech() {
        assert!(is_vaca_protector_host("systemtech.space"));
        assert!(is_vaca_protector_host("cdn.systemads1.com"));
        assert!(!is_vaca_protector_host("t.co"), "ASSERT_ONLY não é botão");
    }
}
