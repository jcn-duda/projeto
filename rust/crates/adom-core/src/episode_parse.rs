//! Porte de `parseTitleSeasonEpisode` e `seasonCoverageExcludes`
//! (`src/utils/episode-matching.ts`): temporada, episódio e marcadores de pack
//! lidos do título da release.
//!
//! Regras de paridade com o JS (sem a flag `u`):
//! - `\s` vira a classe `SP` (espaços Unicode do ECMAScript); `\d` vira `[0-9]`.
//! - `\b` é ASCII. Antes de palavra, vira `(?<![A-Z0-9_])` no texto cru.
//! - Padrões com `/i` são escritos em MAIÚSCULA e casam em `raw_c`, que é o
//!   `js_canon` do cru (o case folding do `/i` sem `u`). Padrões sem `/i`
//!   casam em `t`, o título normalizado.
//! - Conjuntos são `Vec` com inserção na ordem do `Set` do JS.

use std::sync::OnceLock;

use crate::br_origin::js_canon;
use crate::episode_parse_gate::GatedRegex;
use crate::episode_parse_scan::{letter_number, season_episodes};
use crate::title_normalization::normalize_title;

const MAX_SEASON_SPAN: i64 = 30;
/// Pack de novela medido: até 43 capítulos; 200 barra faixa lida de ruído.
const MAX_CHAPTER_SPAN: i64 = 200;
const WRITTEN_ORDINALS: [&str; 10] = [
    "primeira", "segunda", "terceira", "quarta", "quinta", "sexta", "setima", "oitava", "nona",
    "decima",
];

/// Espaços do `\s` do ECMAScript, como conteúdo de classe de caractere.
const SP: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// Compila (uma vez por padrão) com o `__SP__` trocado pela classe de espaços.
/// Cada padrão leva o portão relaxado (`episode_parse_gate`).
macro_rules! re {
    ($pat:expr) => {{
        static CELL: OnceLock<GatedRegex> = OnceLock::new();
        CELL.get_or_init(|| GatedRegex::new(&$pat.replace("__SP__", SP)))
    }};
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSeasonEpisode {
    pub seasons: Vec<i64>,
    pub episodes: Vec<i64>,
    pub complete: bool,
    pub season_pack: bool,
}

/// Captura já possuída: grupos como texto e o fim do casamento inteiro.
struct Caps {
    end: usize,
    groups: Vec<Option<String>>,
}

impl Caps {
    /// Grupo `i` como texto (vazio se não participou).
    fn g(&self, i: usize) -> &str {
        self.groups.get(i).and_then(|x| x.as_deref()).unwrap_or("")
    }

    /// Grupo `i` quando participou.
    fn opt(&self, i: usize) -> Option<&str> {
        self.groups.get(i).and_then(|x| x.as_deref())
    }
}

fn caps_of(c: &fancy_regex::Captures<'_, str>) -> Caps {
    let whole = c.get(0).expect("grupo 0 sempre existe");
    Caps {
        end: whole.end(),
        groups: (0..c.len())
            .map(|i| c.get(i).map(|m| m.as_str().to_string()))
            .collect(),
    }
}

fn all(re: &GatedRegex, text: &str) -> Vec<Caps> {
    if !re.may_match(text) {
        return Vec::new();
    }
    re.fancy
        .captures_iter(text)
        .map(|c| caps_of(&c.expect("regex de episódio executa")))
        .collect()
}

fn first(re: &GatedRegex, text: &str) -> Option<Caps> {
    if !re.may_match(text) {
        return None;
    }
    re.fancy
        .captures(text)
        .expect("regex de episódio executa")
        .map(|c| caps_of(&c))
}

fn num(s: &str) -> i64 {
    s.parse().expect("grupo numérico")
}

fn push_unique(v: &mut Vec<i64>, n: i64) {
    if !v.contains(&n) {
        v.push(n);
    }
}

/// Expande faixa de temporadas quando hi > lo e a amplitude cabe no teto.
fn add_season_span(seasons: &mut Vec<i64>, lo: i64, hi: i64) {
    if hi > lo && hi - lo <= MAX_SEASON_SPAN {
        for i in lo..=hi {
            push_unique(seasons, i);
        }
    }
}

fn add_range(episodes: &mut Vec<i64>, lo: i64, hi: i64) {
    for i in lo..=hi {
        push_unique(episodes, i);
    }
}

/// Extrai temporada/episódio do título da release.
pub fn parse_title_season_episode(title: &str) -> ParsedSeasonEpisode {
    parse_title_season_episode_prepared(&normalize_title(title), &js_canon(title))
}

/// `parse_title_season_episode` com o `normalize_title` (`t`) e o `js_canon`
/// (`raw_c`) do título já calculados (`release_title_facts` os reusa).
pub(crate) fn parse_title_season_episode_prepared(t: &str, raw_c: &str) -> ParsedSeasonEpisode {
    let mut seasons: Vec<i64> = Vec::new();
    let mut episodes: Vec<i64> = Vec::new();

    // (1) "s01e04", "s01 e04", "s01e01 e10" (intervalo), "s01e01e02" — no título normalizado.
    // Regex de referência (`episode_parse_scan`):
    // `(?<![a-z0-9])s([0-9]{1,2})((?:[__SP__]?e[__SP__]?[0-9]{1,4})+)`.
    for (season, eps_text) in season_episodes(t) {
        push_unique(&mut seasons, num(season));
        let eps: Vec<i64> = all(re!(r"e[__SP__]?([0-9]{1,4})"), eps_text)
            .iter()
            .map(|x| num(x.g(1)))
            .collect();
        if eps.len() >= 2 {
            let lo = *eps.iter().min().expect("dois ou mais");
            let hi = *eps.iter().max().expect("dois ou mais");
            add_range(&mut episodes, lo, hi);
        } else {
            for e in eps {
                push_unique(&mut episodes, e);
            }
        }
    }

    // (2) Intervalo com o segundo número nu no cru: "S03E01-02". SEM âncora à
    // esquerda, como no TS: o "S" colado na palavra ("VoxMachinaS03E10-11") também
    // conta — medido no banco de magnets, onde a âncora zerava o pack.
    for c in all(
        re!(r"S([0-9]{1,2})[__SP__]?E([0-9]{1,4})[__SP__]*[-–][__SP__]*([0-9]{1,4})(?![0-9P])"),
        raw_c,
    ) {
        let lo = num(c.g(2));
        let hi = num(c.g(3));
        if hi <= lo || hi - lo > 30 {
            continue;
        }
        push_unique(&mut seasons, num(c.g(1)));
        add_range(&mut episodes, lo, hi);
    }

    // (3) "S01 EP 07" / "S01 EP (01-07)" das releases indianas.
    for c in all(
        re!(
            r"(?<![A-Z0-9])S([0-9]{1,2})[__SP__._-]*EP\.?[__SP__._-]*\(?([0-9]{1,3})(?:[__SP__]*[-–][__SP__]*([0-9]{1,3}))?\)?(?![0-9P])"
        ),
        raw_c,
    ) {
        let lo = num(c.g(2));
        let hi = c.opt(3).map_or(lo, num);
        if hi < lo || hi - lo > 30 {
            continue;
        }
        push_unique(&mut seasons, num(c.g(1)));
        add_range(&mut episodes, lo, hi);
    }

    // (4) Trackers BR: "T01 E004", "T01E004", com lista/intervalo no cru.
    let t_re = re!(r"(?:^|[^A-Z0-9])T([0-9]{1,2})[__SP__]*E[__SP__]?([0-9]{1,3})");
    let tail_re = re!(
        r"^(?:[__SP__]*([-–—])[__SP__]*|[__SP__]*(?:E|AND)[__SP__]+|[__SP__]*,[__SP__]*|[__SP__]+)E[__SP__]?([0-9]{1,3})"
    );
    for c in all(t_re, raw_c) {
        push_unique(&mut seasons, num(c.g(1)));
        let mut eps = vec![num(c.g(2))];
        let mut cursor = c.end;
        let mut ranged = false;
        while cursor < raw_c.len() {
            let Some(next) = first(tail_re, &raw_c[cursor..]) else {
                break;
            };
            ranged |= next.opt(1).is_some();
            eps.push(num(next.g(2)));
            cursor += next.end;
        }
        if ranged {
            let lo = *eps.iter().min().expect("ao menos um");
            let hi = *eps.iter().max().expect("ao menos um");
            add_range(&mut episodes, lo, hi);
        } else {
            for e in eps {
                push_unique(&mut episodes, e);
            }
        }
    }

    // (5) Faixa de capítulos de novela, sem temporada: "[Capítulo 086 ao 123]".
    for c in all(
        re!(
            r"(?<![A-Z0-9])(?:CAP[IÍ]TULOS?|EPIS[OÓ]DIOS?|EPS?)\.?[__SP__]*([0-9]{1,3})[__SP__]*(?:[-–]|(?<![A-Z0-9_])(?:AO|A|AT[EÉ])(?![A-Z]))[__SP__]*([0-9]{1,3})(?![0-9P])"
        ),
        raw_c,
    ) {
        let lo = num(c.g(1));
        let hi = num(c.g(2));
        if hi <= lo || hi - lo > MAX_CHAPTER_SPAN {
            continue;
        }
        add_range(&mut episodes, lo, hi);
    }

    // (6) "1x04" no normalizado; lookbehind barra "1280x720".
    for c in all(re!(r"(?<![a-z0-9])([0-9]{1,2})x([0-9]{1,3})"), t) {
        push_unique(&mut seasons, num(c.g(1)));
        push_unique(&mut episodes, num(c.g(2)));
    }

    // (7) Ordinal por extenso: "Primeira Temporada", "Décima Primeira Temporada".
    for c in all(
        re!(
            r"(?<![a-z0-9])(primeira|segunda|terceira|quarta|quinta|sexta|setima|oitava|nona|decima)(?:[__SP__]+(primeira|segunda|terceira|quarta|quinta|sexta|setima|oitava|nona))?[__SP__]+temporada(?![a-z])"
        ),
        t,
    ) {
        let idx = |w: &str| {
            WRITTEN_ORDINALS
                .iter()
                .position(|x| *x == w)
                .expect("ordinal conhecido") as i64
                + 1
        };
        let second = c.opt(2);
        let extra = if second.is_some() && c.g(1) == "decima" {
            idx(c.g(2))
        } else {
            0
        };
        let n = idx(c.g(1)) + extra;
        if n >= 1 {
            push_unique(&mut seasons, n);
        }
    }

    // (8) Faixa: "1ª até 8ª Temporada", "1 a 5 temporadas".
    for c in all(
        re!(
            r"(?<![0-9])([0-9]{1,2})(?:[__SP__]*a)?[__SP__]*(?:ate|a)[__SP__]*([0-9]{1,2})(?![0-9])(?:[__SP__]*a)?[__SP__]*temporadas?"
        ),
        t,
    ) {
        let a = num(c.g(1));
        let b = num(c.g(2));
        let (lo, hi) = (a.min(b), a.max(b));
        if hi - lo <= MAX_SEASON_SPAN {
            add_range(&mut seasons, lo, hi);
        }
    }

    // (9) Lista de ordinais antes de "Temporadas" no plural: "1ª 2ª 3ª e 7ª Temporadas".
    for c in all(
        re!(
            r"((?:(?<![a-z0-9])[0-9]{1,2}[__SP__]+){2,}(?:e[__SP__]+)?(?<![a-z0-9])[0-9]{1,2}[__SP__]+)temporadas"
        ),
        t,
    ) {
        for num_text in all(re!(r"[0-9]{1,2}"), c.g(1)) {
            let season = num(num_text.g(0));
            if (1..=MAX_SEASON_SPAN).contains(&season) {
                push_unique(&mut seasons, season);
            }
        }
    }

    // (10) Faixa de cena no cru: "S01-S04", "S01 - S04".
    for c in all(
        re!(r"(?<![A-Z0-9])S([0-9]{1,2})[__SP__]*[-–—][__SP__]*S([0-9]{1,2})(?![0-9E])"),
        raw_c,
    ) {
        add_season_span(&mut seasons, num(c.g(1)), num(c.g(2)));
    }
    // "S01-03" (teto 10 só nesta forma: "Anime S02-13" seria episódio).
    for c in all(
        re!(r"(?<![A-Z0-9])S([0-9]{2})-([0-9]{2})(?![A-Z0-9])"),
        raw_c,
    ) {
        let lo = num(c.g(1));
        let hi = num(c.g(2));
        if hi > lo && hi - lo <= 10 {
            add_range(&mut seasons, lo, hi);
        }
    }
    // "S1-3E1".
    for c in all(
        re!(r"(?<![A-Z0-9])S([0-9]{1,2})-([0-9]{1,2})E[0-9]"),
        raw_c,
    ) {
        add_season_span(&mut seasons, num(c.g(1)), num(c.g(2)));
    }

    // Pack: "s01", "season 1", "temporada 1", "1 temporada".
    // `(?<![a-z0-9])s([0-9]{1,2})(?![a-z0-9])`, por scanner.
    for season in letter_number(t, b's', 2) {
        push_unique(&mut seasons, num(season));
    }
    for c in all(
        re!(r"(?:season|temporada)[__SP__]?([0-9]{1,2})(?![0-9])"),
        t,
    ) {
        push_unique(&mut seasons, num(c.g(1)));
    }
    for c in all(
        re!(r"(?<![0-9])([0-9]{1,2})(?![0-9])[__SP__]?a?[__SP__]?temporada"),
        t,
    ) {
        push_unique(&mut seasons, num(c.g(1)));
    }

    // Série inteira e pack de temporada nomeada.
    let complete = re!(r"(?:todas?[__SP__]+(?:as[__SP__]+)?temporadas|serie[__SP__]+completa|temporadas[__SP__]+completas)")
        .fancy
        .is_match(t)
        .expect("regex de episódio executa");
    let season_pack = re!(r"temporada[__SP__]+completa")
        .fancy
        .is_match(t)
        .expect("regex de episódio executa");

    // Episódio solto só conta quando a temporada já apareceu.
    if !seasons.is_empty() && episodes.is_empty() {
        for c in all(re!(r"epis[oó]dio[__SP__]?([0-9]{1,3})"), t) {
            push_unique(&mut episodes, num(c.g(1)));
        }
        // `(?<![a-z0-9])e([0-9]{1,3})(?![a-z0-9])`, por scanner.
        let loose: Vec<i64> = letter_number(t, b'e', 3).into_iter().map(num).collect();
        if loose.len() >= 2 {
            let lo = *loose.iter().min().expect("dois ou mais");
            let hi = *loose.iter().max().expect("dois ou mais");
            add_range(&mut episodes, lo, hi);
        } else {
            for e in loose {
                push_unique(&mut episodes, e);
            }
        }
    }

    ParsedSeasonEpisode {
        seasons,
        episodes,
        complete,
        season_pack,
    }
}

/// Cobertura explícita que exclui a temporada pedida não pode virar "talvez".
pub fn season_coverage_excludes(parsed: &ParsedSeasonEpisode, season: Option<i64>) -> bool {
    season.is_some_and(|s| !parsed.seasons.is_empty() && !parsed.seasons.contains(&s))
}

