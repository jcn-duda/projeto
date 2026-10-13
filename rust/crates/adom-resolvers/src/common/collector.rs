//! `createLinkCollector` de `resolvers/link-collector.ts`: a máquina de estados
//! da âncora, comum aos profiles. Percorre o post EM ORDEM DE DOCUMENTO mantendo
//! o áudio da seção corrente e o episódio do segmento, e extrai cada botão. O
//! site aporta a regex de âncora, a resolução do href e os classificadores.

use std::sync::LazyLock;

use adom_crawl::profile_parsers::ResolverLink;
use fancy_regex::{Captures, Regex as FancyRegex};
use regex::Regex;

/// Resultado do `resolveHref` do site.
pub enum Resolved {
    /// Botão de download com a URL final (magnet ou protetor).
    Url(String),
    /// Âncora descartada. `advance: true` avança o cursor da seção mesmo assim
    /// (comando/vaca em falha de URL); `false` é a âncora não-download
    /// preservada: o contexto dela segue no segmento do próximo botão.
    Skip { advance: bool },
}

/// Saída do passo de episódio (`EpisodeStep` do TS).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Step {
    pub state: Option<u32>,
    pub episode: Option<u32>,
    pub episode_last: Option<u32>,
}

/// Ganchos do site — o `LinkCollectorConfig` do TS.
pub trait CollectorHooks {
    fn anchor_re(&self) -> &FancyRegex;
    fn resolve_href(
        &self,
        caps: &Captures<'_, str>,
        html: &str,
        base_url: Option<&str>,
    ) -> Resolved;
    fn anchor_text_of(&self, caps: &Captures<'_, str>) -> String;
    fn strip_tags(&self, value: &str) -> String;
    /// `None` = sem áudio conhecido até um marcador aparecer (vaca).
    fn initial_audio(&self) -> Option<String>;
    fn audio_from_segment(&self, segment: &str) -> Option<String>;
    /// `audioFromAnchor` opcional do TS; `None` = o botão herda a seção.
    fn audio_from_anchor(&self, _anchor_text: &str) -> Option<String> {
        None
    }
    /// `Err` = o `throw` do TS (o `matchAll` sem `/g` do desempate de
    /// comando/vaca), preservado: no botão emitido ele derruba o post inteiro.
    fn episode_step(
        &self,
        segment: &str,
        anchor_text: &str,
        current: Option<u32>,
    ) -> Result<Step, String>;
    fn quality(&self, context: &str) -> Option<u32>;
    fn source(&self, context: &str) -> Option<String>;
    fn decode_html(&self, html: &str) -> String {
        html.to_string()
    }
    /// `extrasOf(options)` do TS: campos extras do item (vaca: season/real_title).
    fn extras(&self, _link: &mut ResolverLink) {}
}

/// `/([\d.,]+)\s*(TB|GB|MB|KB)\b/g` sobre o contexto já em maiúsculas.
static SIZE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([0-9.,]+)\s*(TB|GB|MB|KB)(?-u:\b)").expect("regex de tamanho"));

/// `toUpperCase` do JS sobre o texto do segmento/âncora.
fn upper(value: &str) -> String {
    value.to_uppercase()
}

/// Lê os botões do post. `Err` só quando o passo de episódio de um botão
/// emitido lança — o mesmo `throw` que o TS deixa subir.
pub fn parse_download_links(
    hooks: &dyn CollectorHooks,
    html: &str,
    base_url: Option<&str>,
) -> Result<Vec<ResolverLink>, String> {
    let source = hooks.decode_html(html);
    let mut links = Vec::new();
    let mut audio = hooks.initial_audio();
    let mut current_episode: Option<u32> = None;
    let mut cursor = 0usize;
    for caps in hooks.anchor_re().captures_iter(source.as_str()) {
        let Ok(caps) = caps else {
            // Estouro de backtracking do fancy-regex: o JS não falha aqui, então
            // para com o que já leu em vez de propagar.
            break;
        };
        let whole = caps.get(0).expect("grupo 0 sempre existe");
        let resolved = hooks.resolve_href(&caps, &source, base_url);
        match resolved {
            Resolved::Skip { advance: true } => {
                cursor = whole.end();
            }
            Resolved::Skip { advance: false } => {
                let segment = upper(&hooks.strip_tags(slice(&source, cursor, whole.start())));
                let anchor_text = upper(&hooks.anchor_text_of(&caps));
                // Âncora transparente: um throw aqui não aborta a página; vale o
                // estado anterior (o `try/catch` do TS).
                if let Ok(step) = hooks.episode_step(&segment, &anchor_text, current_episode) {
                    current_episode = step.state;
                }
            }
            Resolved::Url(url) => {
                let segment = upper(&hooks.strip_tags(slice(&source, cursor, whole.start())));
                let anchor_text = upper(&hooks.anchor_text_of(&caps));
                cursor = whole.end();

                if let Some(seg_audio) = hooks.audio_from_segment(&segment) {
                    audio = Some(seg_audio);
                }
                let local_audio = hooks.audio_from_anchor(&anchor_text);

                let step = hooks.episode_step(&segment, &anchor_text, current_episode)?;
                current_episode = step.state;

                let context = format!("{segment} {anchor_text}");
                let size = SIZE_RE
                    .captures_iter(&context)
                    .last()
                    .map(|c| format!("{} {}", &c[1], &c[2]));
                let mut item = ResolverLink {
                    url,
                    quality: hooks.quality(&context),
                    size,
                    audio: local_audio.or_else(|| audio.clone()),
                    episode: step.episode,
                    episode_last: step.episode_last,
                    source: hooks.source(&context),
                    ..Default::default()
                };
                hooks.extras(&mut item);
                links.push(item);
            }
        }
    }
    Ok(links)
}

/// `source.slice(cursor, match.index)` tolerante: cursor além do match vira vazio.
fn slice(source: &str, from: usize, to: usize) -> &str {
    if from >= to {
        ""
    } else {
        &source[from..to]
    }
}
