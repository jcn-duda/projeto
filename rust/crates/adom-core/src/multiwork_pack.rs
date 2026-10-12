//! Porte puro de `src/utils/multiwork-pack.ts`: admissão de packs multiobra BR
//! (coleção de franquia admitida só com evidência forte).
//!
//! Funções exportadas: `collection_root`, `collection_root_tokens`,
//! `covers_year`, `pack_year_source` e `admits_multi_work_pack`. Os itens
//! `RawItem` viram `title` e `magnet` já resolvidos (o fallback `title || Title`
//! e `magnet || MagnetUri` fica com quem monta o item); `multiWork` vira só a
//! raiz (`Option<&str>`), porque só ela entra na checagem.
//!
//! `franchise_root` e `contains_token_run` são portes de helpers de
//! `release-name-matching.ts`. Ficam aqui (`pub(crate)`) porque o módulo
//! inteiro ainda não foi portado; quando ele entrar, mudam de casa.
//!
//! Regex do JS sem lookaround: `(?<!\d)`, `(?!\d)` e `\b` ASCII viram
//! comparações explícitas sobre `Vec<char>`. `\s` é o conjunto do `trim` do
//! JS (`js_trim`), `\d` é `[0-9]` e `/i` vale só para ASCII (com a exceção do
//! `é` de "até", que o JS também dobra).

use crate::franchise::is_multi_work_collection;
use crate::js_text::{js_decode_uri_component, js_trim};
use crate::matching_decisions::first_year_in;
use crate::matching_vocabulary::{leading_articles, title_tokens};

/// `COLLECTION_NOISE`: palavras de EMPACOTAMENTO no nome da coleção, não da
/// franquia. Artigos e preposições ficam (a raiz precisa ser contígua).
pub const COLLECTION_NOISE: &str = "colecao coletanea trilogia duologia quadrilogia pentalogia antologia filmografia filmography trilogy quadrilogy duology tetralogy anthology boxset box collection saga completo completa completos completas";

/// Espaço no sentido JS (o mesmo do `trim`), por reuso do helper do crate.
fn is_js_space(c: char) -> bool {
    js_trim(c.encode_utf8(&mut [0; 4])).is_empty()
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `\w` do JS: ASCII alfanumérico e `_`.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\b` do JS entre `p-1` e `p` (fora do texto conta como não-palavra).
fn boundary(s: &[char], p: usize) -> bool {
    let prev = p > 0 && is_word(s[p - 1]);
    let next = p < s.len() && is_word(s[p]);
    prev != next
}

/// Número de palavras separadas por espaço JS (`split(/\s+/).filter(Boolean)`).
fn word_count(s: &str) -> usize {
    s.split(is_js_space).filter(|w| !w.is_empty()).count()
}

/// Separadores do corte de subtítulo: `:`, en dash e em dash.
fn is_cut_sep(c: char) -> bool {
    matches!(c, ':' | '–' | '—')
}

/// Candidato do `^([^:–—]+?)([:–—].*)?$`, ou `None` quando a regex não casa.
/// O `.*` do JS não atravessa quebra de linha, e o grupo 1 exige 1+ caractere.
fn cut_candidate(raw: &str) -> Option<&str> {
    match raw.find(is_cut_sep) {
        None => Some(raw),
        Some(0) => None,
        Some(p) => {
            let sep_len = raw[p..].chars().next().map_or(1, char::len_utf8);
            if raw[p + sep_len..].chars().any(is_line_terminator) {
                None
            } else {
                Some(&raw[..p])
            }
        }
    }
}

/// `\s+(?:parte\s+)?(?:[ivx]{1,4}|\d{1,2})$` (ASCII, sem caixa) a partir de
/// um espaço. `t` começa no espaço do candidato.
fn tail_matches(t: &str) -> bool {
    let Some(rest) = strip_leading_spaces(t) else {
        return false;
    };
    if is_numeral_tail(rest) {
        return true;
    }
    match rest.get(..5) {
        Some(word) if word.eq_ignore_ascii_case("parte") => {
            strip_leading_spaces(&rest[5..]).is_some_and(is_numeral_tail)
        }
        _ => false,
    }
}

/// Remove espaços iniciais. `None` quando não há nenhum (o `\s+` exige um).
fn strip_leading_spaces(s: &str) -> Option<&str> {
    let trimmed = s.trim_start_matches(is_js_space);
    if trimmed.len() == s.len() {
        None
    } else {
        Some(trimmed)
    }
}

/// `[ivx]{1,4}` ou `\d{1,2}` ocupando o texto inteiro (âncora `$`).
fn is_numeral_tail(x: &str) -> bool {
    let n = x.chars().count();
    if (1..=4).contains(&n)
        && x.chars()
            .all(|c| matches!(c, 'i' | 'v' | 'x' | 'I' | 'V' | 'X'))
    {
        return true;
    }
    (1..=2).contains(&n) && x.chars().all(|c| c.is_ascii_digit())
}

/// `head.replace(SEQUENCE_TAIL, '')`: remove o marcador de sequência do fim
/// (primeiro casamento, o mais à esquerda).
fn strip_sequence_tail(s: &str) -> &str {
    for (i, c) in s.char_indices() {
        if is_js_space(c) && tail_matches(&s[i..]) {
            return &s[..i];
        }
    }
    s
}

/// `franchiseRoot`: raiz da franquia de um título (ver release-name-matching.ts).
pub(crate) fn franchise_root(title: &str) -> String {
    let raw = js_trim(title);
    if raw.is_empty() {
        return String::new();
    }
    let mut head = raw.to_string();
    if let Some(candidate) = cut_candidate(raw) {
        let candidate = js_trim(candidate);
        if word_count(candidate) >= 2 {
            head = candidate.to_string();
        }
    }
    let root = js_trim(strip_sequence_tail(&head));
    if !root.is_empty() && word_count(root) >= 2 {
        return root.to_string();
    }
    head
}

fn is_collection_noise(token: &str) -> bool {
    COLLECTION_NOISE.split(' ').any(|w| w == token)
}

/// `collectionRootTokens`: tokens normalizados da raiz da coleção. Sem dois
/// tokens significativos, `[]` (admissão negada).
pub fn collection_root_tokens(name: &str) -> Vec<String> {
    let head = franchise_root(name);
    let mut tokens: Vec<String> = title_tokens(&head)
        .into_iter()
        .filter(|t| !is_collection_noise(t))
        .collect();
    while tokens
        .first()
        .is_some_and(|t| leading_articles().contains(t.as_str()))
    {
        tokens.remove(0);
    }
    if tokens.len() >= 2 {
        tokens
    } else {
        Vec::new()
    }
}

/// `collectionRoot`: a raiz como string normalizada, ou `""`.
pub fn collection_root(name: &str) -> String {
    collection_root_tokens(name).join(" ")
}

/// Ano em `[0-9]{3,4}x[0-9]{3,4}` (resolução) começando em `i`, com o fim.
fn resolution_end(s: &[char], i: usize) -> Option<usize> {
    let first = digit_run(s, i);
    if first != 3 && first != 4 {
        return None;
    }
    let x = i + first;
    if !matches!(s.get(x), Some('x' | 'X')) {
        return None;
    }
    let second = digit_run(s, x + 1);
    if second < 3 {
        return None;
    }
    Some(x + 1 + second.min(4))
}

/// Quantos dígitos ASCII seguidos começam em `i`.
fn digit_run(s: &[char], i: usize) -> usize {
    s.get(i..).map_or(0, |rest| {
        rest.iter().take_while(|c| c.is_ascii_digit()).count()
    })
}

/// `text.replace(/\d{3,4}x\d{3,4}/gi, ' ')`.
fn strip_resolutions(s: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        match resolution_end(s, i) {
            Some(end) => {
                out.push(' ');
                i = end;
            }
            None => {
                out.push(s[i]);
                i += 1;
            }
        }
    }
    out
}

/// `(19|20)\d{2}` em `i`, como número.
fn year_at(s: &[char], i: usize) -> Option<i64> {
    let d = s.get(i..i + 4)?;
    let prefix_ok = (d[0] == '1' && d[1] == '9') || (d[0] == '2' && d[1] == '0');
    if !prefix_ok || !d[2].is_ascii_digit() || !d[3].is_ascii_digit() {
        return None;
    }
    Some(d.iter().fold(0_i64, |acc, c| {
        acc * 10 + i64::from(c.to_digit(10).unwrap_or(0))
    }))
}

/// Segundo ano de uma faixa em `k`: `(19|20)\d{2}(?!\d)`. Devolve o valor e o
/// índice logo depois dele.
fn second_year(s: &[char], k: usize) -> Option<(i64, usize)> {
    let b = year_at(s, k)?;
    if s.get(k + 4).is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((b, k + 4))
}

fn skip_spaces(s: &[char], mut i: usize) -> usize {
    while i < s.len() && is_js_space(s[i]) {
        i += 1;
    }
    i
}

fn is_range_sep(c: char) -> bool {
    matches!(c, '-' | '–' | '—' | '~')
}

/// Casa `word` sem distinguir caixa em `at`; devolve o índice depois dele.
/// A dobra é a do JS sem `u`: ASCII por `to_ascii_uppercase`, e não-ASCII só
/// quando o maiúsculo continua não-ASCII (o `é` de "até" dobra; `ı` não vira `I`).
fn match_word(s: &[char], at: usize, word: &str) -> Option<usize> {
    let mut k = at;
    for w in word.chars() {
        let c = *s.get(k)?;
        if fold(c) != fold(w) {
            return None;
        }
        k += 1;
    }
    Some(k)
}

fn fold(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_uppercase();
    }
    let mut upper = c.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(u), None) if !u.is_ascii() => u,
        _ => c,
    }
}

/// `(?<!\d)(19|20)\d{2}\s*(?:[-–—~]|\b(?:de|a|até|ate|to)\b)\s*(19|20)\d{2}(?!\d)`
/// começando em `i`. Devolve (ano inicial, ano final, fim do casamento).
fn range_at(s: &[char], i: usize) -> Option<(i64, i64, usize)> {
    if i > 0 && s[i - 1].is_ascii_digit() {
        return None;
    }
    let a = year_at(s, i)?;
    let j = skip_spaces(s, i + 4);
    if s.get(j).is_some_and(|&c| is_range_sep(c)) {
        let (b, end) = second_year(s, skip_spaces(s, j + 1))?;
        return Some((a, b, end));
    }
    for word in ["de", "a", "até", "ate", "to"] {
        let Some(word_end) = match_word(s, j, word) else {
            continue;
        };
        if !boundary(s, j) || !boundary(s, word_end) {
            continue;
        }
        if let Some((b, end)) = second_year(s, skip_spaces(s, word_end)) {
            return Some((a, b, end));
        }
    }
    None
}

/// Troca todas as faixas por espaço e devolve também os pares (início, fim).
fn take_ranges(s: &[char]) -> (Vec<char>, Vec<(i64, i64)>) {
    let mut out = Vec::with_capacity(s.len());
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < s.len() {
        match range_at(s, i) {
            Some((a, b, end)) => {
                ranges.push((a, b));
                out.push(' ');
                i = end;
            }
            None => {
                out.push(s[i]);
                i += 1;
            }
        }
    }
    (out, ranges)
}

/// Anos avulsos `(?<!\d)(19|20)\d{2}(?!\d)`, na ordem do texto.
fn single_years(s: &[char]) -> Vec<i64> {
    (0..s.len())
        .filter(|&i| !(i > 0 && s[i - 1].is_ascii_digit()))
        .filter_map(|i| {
            let y = year_at(s, i)?;
            if s.get(i + 4).is_some_and(|c| c.is_ascii_digit()) {
                None
            } else {
                Some(y)
            }
        })
        .collect()
}

/// `coversYear`: o texto DECLARA cobertura do ano? Faixa precisa conter o ano
/// (sem folga); ano avulso tem tolerância de ±2. Resolução não conta.
pub fn covers_year(text: &str, catalog_year: &str) -> bool {
    let year = first_year_in(catalog_year);
    if year == 0 {
        return false;
    }
    let chars: Vec<char> = text.chars().collect();
    let without_resolutions = strip_resolutions(&chars);
    let (rest, ranges) = take_ranges(&without_resolutions);
    if ranges
        .iter()
        .any(|&(a, b)| a.min(b) <= year && year <= a.max(b))
    {
        return true;
    }
    single_years(&rest)
        .into_iter()
        .any(|single| (single - year).abs() <= 2)
}

/// `packYearSource`: título + `dn=` decodificado quando o magnet é real.
/// URL de protetor não tem `dn=` que valha; sem ele, vale só o título.
pub fn pack_year_source(title: &str, magnet: &str) -> String {
    if !starts_with_magnet(js_trim(magnet)) {
        return title.to_string();
    }
    let Some(dn) = dn_value(magnet) else {
        return title.to_string();
    };
    let plus = dn.replace('+', " ");
    let decoded = js_decode_uri_component(&plus).unwrap_or(plus);
    format!("{title} {decoded}")
}

/// `/^magnet:/i` sobre o texto já aparado.
fn starts_with_magnet(s: &str) -> bool {
    s.get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("magnet:"))
}

/// `/[&?]dn=([^&]+)/i`: o primeiro par cujo valor não é vazio.
fn dn_value(raw: &str) -> Option<&str> {
    for (i, c) in raw.char_indices() {
        if c != '&' && c != '?' {
            continue;
        }
        let after = &raw[i + 1..];
        let Some(head) = after.get(..3) else {
            continue;
        };
        if !head.eq_ignore_ascii_case("dn=") {
            continue;
        }
        let value = after[3..].split('&').next().unwrap_or("");
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// `containsTokenRun`: o título tem a raiz como sequência contígua de tokens.
pub(crate) fn contains_token_run(title: &str, normalized_root: &str) -> bool {
    let haystack = title_tokens(title);
    let needle: Vec<&str> = normalized_root
        .split(' ')
        .filter(|t| !t.is_empty())
        .collect();
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window.iter().zip(&needle).all(|(a, b)| a.as_str() == *b))
}

/// `admitsMultiWorkPack`: condições sem rede. `multi_work_root` é `None` quando
/// o TS tem `multiWork` nulo ou raiz vazia; `year` é o texto do catálogo (`""`
/// para null). Filme, nomes não vazios, coleção reconhecida, raiz contígua e
/// cobertura explícita do ano.
pub fn admits_multi_work_pack(
    title: &str,
    magnet: &str,
    multi_work_root: Option<&str>,
    year: &str,
    is_series: bool,
    names: &[String],
) -> bool {
    let Some(root) = multi_work_root.filter(|r| !r.is_empty()) else {
        return false;
    };
    if is_series || names.is_empty() || first_year_in(year) == 0 {
        return false;
    }
    let evidence = pack_year_source(title, magnet);
    if !is_multi_work_collection(&evidence) {
        return false;
    }
    if !contains_token_run(&evidence, root) {
        return false;
    }
    covers_year(&evidence, year)
}
