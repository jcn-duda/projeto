//! Regras e passo de episódio de `resolvers/release-rules.ts`
//! (`createEpisodeRules`/`createEpisodeStep`). Separado de `rules.rs` pela
//! catraca de 400 linhas; mesmas convenções de paridade com o JS.

use regex::Regex;

use super::collector::Step;
use super::rules::compile;

// ─── episódio ────────────────────────────────────────────────────────────

/// `DEFAULT_PACK_RESET_RE` (bludv/comandotorrents).
pub const DEFAULT_PACK_RESET: &str = r"(?i){B}(?:TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA|PACK\s+COMPLETO|PACOTE\s+COMPLETO|{B}PACK{B}){B}";
/// `DEFAULT_EPISODE_RANGE_RE`.
pub const DEFAULT_EPISODE_RANGE: &str = r"(?i)(?:EPIS[ÓO]DIOS?|EP|CAP[ÍI]TULOS?|CAP|E)[.\s-]*[0-9]{1,3}[.\s-]*(?:A|AO|[-–—])[.\s-]*[0-9]{1,3}{B}";
/// `EPISODE_PATTERN_RE` (grupos 1..4).
pub const EPISODE_PATTERN: &str = r"(?i)(?:EPIS[ÓO]DIO|EP|CAP[ÍI]TULO|CAP)[.\s-]*([0-9]{1,3}){B}|{B}S[0-9]{1,2}E([0-9]{1,3}){B}|{B}E([0-9]{1,3}){B}|{B}[0-9]{1,2}X([0-9]{1,3}){B}";
/// `NARROW_PACK_RESET_RE` (nerd/tdf).
pub const NARROW_PACK_RESET: &str =
    r"(?i)TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA";
/// `NARROW_EPISODE_RE` (nerd/tdf; grupo 2 = fim do intervalo).
pub const NARROW_EPISODE: &str =
    r"(?i)(?:EPIS[ÓO]DIOS?|EP)\s*([0-9]{1,3})(?:\s*(?:/|-|–|&|E|AO|A)\s*([0-9]{1,3}))?{B}";

/// `createEpisodeRules`: `extractEpisode` com pack/faixa do site.
pub struct EpisodeRules {
    pub pack: Regex,
    pub range: Regex,
    pub episode: Regex,
}

impl EpisodeRules {
    /// Defaults (bludv/comandotorrents); o vaca troca pack e faixa.
    pub fn new(pack: &str, range: &str) -> Self {
        Self {
            pack: compile(pack),
            range: compile(range),
            episode: compile(EPISODE_PATTERN),
        }
    }

    pub fn default_rules() -> Self {
        Self::new(DEFAULT_PACK_RESET, DEFAULT_EPISODE_RANGE)
    }

    /// `extractEpisode`: faixa é PACK (`None`); senão o ÚLTIMO marcador.
    pub fn extract_episode(&self, text: &str) -> Option<u32> {
        if text.is_empty() || self.range.is_match(text) {
            return None;
        }
        let last = self.episode.captures_iter(text).last()?;
        (1..=4)
            .find_map(|g| last.get(g).filter(|m| !m.as_str().is_empty()))
            .and_then(|m| m.as_str().parse().ok())
    }
}

/// Escopo da âncora no passo de episódio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpisodeScope {
    /// bludv/nerd: o sinal da âncora vale SÓ para o botão.
    AnchorLocal,
    /// comando/vaca: a âncora ESCREVE no estado.
    AnchorWrites,
    /// tdf: a âncora nunca interfere.
    SegmentOnly,
}

/// `packMatchAll` do desempate: o bludv passa o clone `/g`; comando/vaca passam
/// o padrão CRU `/i`, e o `matchAll` do JS lança `TypeError` — preservado.
pub enum PackMatchAll<'a> {
    Regex(&'a Regex),
    Throws,
}

/// `createEpisodeStep`.
pub struct EpisodeStepConfig<'a> {
    pub scope: EpisodeScope,
    pub pack: &'a Regex,
    pub range: Option<&'a Regex>,
    pub ep: &'a Regex,
    /// `extract` do TS; `None` = grupo 1 do último match de `ep`.
    pub extract: Option<&'a EpisodeRules>,
    pub pack_match_all: Option<PackMatchAll<'a>>,
    pub tie_break: bool,
    pub ep_range_group: Option<usize>,
}

fn last_match<'t>(text: &'t str, re: &Regex) -> Option<regex::Captures<'t>> {
    re.captures_iter(text).last()
}

fn group_num(caps: &regex::Captures<'_>, group: usize) -> Option<u32> {
    caps.get(group).and_then(|m| m.as_str().parse().ok())
}

impl EpisodeStepConfig<'_> {
    fn is_pack(&self, text: &str) -> bool {
        self.pack.is_match(text) || self.range.is_some_and(|r| r.is_match(text))
    }

    fn extract_of(&self, text: &str) -> Option<u32> {
        match self.extract {
            Some(rules) => rules.extract_episode(text),
            None => last_match(text, self.ep).and_then(|m| group_num(&m, 1)),
        }
    }

    fn segment_state(&self, segment: &str, state: Option<u32>) -> Result<Option<u32>, String> {
        if !self.tie_break {
            if self.pack.is_match(segment) {
                return Ok(None);
            }
            return Ok(match last_match(segment, self.ep) {
                Some(m) => group_num(&m, 1),
                None => state,
            });
        }
        let seg_ep = self.extract_of(segment);
        let seg_is_pack = self.is_pack(segment);
        if seg_ep.is_some() && seg_is_pack {
            let last_ep = last_match(segment, self.ep).map(|m| m.get(0).map_or(0, |g| g.start()));
            let last_pack = match &self.pack_match_all {
                Some(PackMatchAll::Regex(re)) => re.find_iter(segment).last().map(|m| m.start()),
                _ => return Err(
                    "TypeError: String.prototype.matchAll called with a non-global RegExp argument"
                        .to_string(),
                ),
            };
            let ep_idx = last_ep.map_or(-1, |i| i as i64);
            let pack_idx = last_pack.map_or(-1, |i| i as i64);
            return Ok(if ep_idx > pack_idx { seg_ep } else { None });
        }
        if seg_ep.is_some() {
            return Ok(seg_ep);
        }
        if seg_is_pack {
            return Ok(None);
        }
        Ok(state)
    }

    /// Um passo da máquina de estados.
    pub fn step(&self, segment: &str, anchor: &str, state: Option<u32>) -> Result<Step, String> {
        if self.scope == EpisodeScope::AnchorWrites {
            if let Some(ep) = self.extract_of(anchor) {
                return Ok(Step {
                    state: Some(ep),
                    episode: Some(ep),
                    episode_last: None,
                });
            }
            if self.is_pack(anchor) {
                return Ok(Step::default());
            }
            let next = self.segment_state(segment, state)?;
            return Ok(Step {
                state: next,
                episode: next,
                episode_last: None,
            });
        }
        let next = self.segment_state(segment, state)?;
        if self.scope == EpisodeScope::SegmentOnly {
            return Ok(Step {
                state: next,
                episode: next,
                episode_last: None,
            });
        }
        let self_ep = self.extract_of(anchor);
        if self.is_pack(anchor) {
            return Ok(Step {
                state: next,
                episode: None,
                episode_last: None,
            });
        }
        let Some(self_ep) = self_ep else {
            return Ok(Step {
                state: next,
                episode: next,
                episode_last: None,
            });
        };
        let last = self
            .ep_range_group
            .and_then(|g| last_match(anchor, self.ep).and_then(|m| group_num(&m, g)));
        Ok(match last {
            Some(l) if l > self_ep => Step {
                state: next,
                episode: Some(self_ep),
                episode_last: Some(l),
            },
            _ => Step {
                state: next,
                episode: Some(self_ep),
                episode_last: None,
            },
        })
    }
}
