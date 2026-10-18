//! Moldagem da Query Torznab — porte de `shapeSearchQuery` / `budgetFor`.
//!
//! Invariante 4: `strip_diacritics` SÓ sob `is_br`. Globais colapsam sigla com
//! ponto (`collapse_acronyms`); BR mantêm os pontos (BLUDV: "S.W.A.T." ≠ "SWAT").

use adom_core::{collapse_acronyms, strip_diacritics};

use super::config::JackettConfig;

/// Orçamento AO VIVO do indexer (busca + resolve): BR/slow usam o teto longo.
pub fn budget_for(indexer: &str, cfg: &JackettConfig) -> u64 {
    if cfg.is_br(indexer) || cfg.is_slow(indexer) {
        cfg.br_indexer_timeout_ms
    } else {
        cfg.indexer_timeout_ms
    }
}

/// O que o Jackett recebe como `Query`.
///
/// - BR: remove episódio do token (`S02E05` → `S02`), tira diacríticos, e nos
///   `bare_title` também o ano final.
/// - Global: colapsa sigla pontuada; NÃO tira acento (a varredura pt-BR nos
///   globais depende disso).
pub fn shape_search_query(_indexer: &str, query: &str, is_br: bool, bare_title: bool) -> String {
    let mut shaped = query.to_string();
    if is_br {
        shaped = strip_episode_keep_season(&shaped);
        shaped = strip_diacritics(&shaped);
    } else {
        shaped = collapse_acronyms(&shaped);
    }
    if bare_title {
        shaped = strip_trailing_year(&shaped);
    }
    shaped = collapse_spaces(&shaped);
    // Moldagem nunca devolve SÓ o token de temporada.
    if is_season_only(&shaped) {
        return query.to_string();
    }
    if shaped.is_empty() {
        query.to_string()
    } else {
        shaped
    }
}

/// Atalho com as listas da config.
pub fn shape_for(indexer: &str, query: &str, cfg: &JackettConfig) -> String {
    shape_search_query(
        indexer,
        query,
        cfg.is_br(indexer),
        cfg.is_bare_title(indexer),
    )
}

/// `/\bS(\d{1,2})E\d{1,3}\b/gi` → `S$1` (case-insensitive, ASCII).
fn strip_episode_keep_season(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if is_word_boundary_before(bytes, i)
            && (bytes[i] == b'S' || bytes[i] == b's')
            && i + 1 < bytes.len()
            && bytes[i + 1].is_ascii_digit()
        {
            let season_start = i + 1;
            let mut season_end = season_start;
            while season_end < bytes.len()
                && season_end - season_start < 2
                && bytes[season_end].is_ascii_digit()
            {
                season_end += 1;
            }
            if season_end > season_start
                && season_end < bytes.len()
                && (bytes[season_end] == b'E' || bytes[season_end] == b'e')
                && season_end + 1 < bytes.len()
                && bytes[season_end + 1].is_ascii_digit()
            {
                let mut ep_end = season_end + 1;
                while ep_end < bytes.len()
                    && ep_end - (season_end + 1) < 3
                    && bytes[ep_end].is_ascii_digit()
                {
                    ep_end += 1;
                }
                if is_word_boundary_before(bytes, ep_end) || ep_end == bytes.len() {
                    out.push('S');
                    out.push_str(&input[season_start..season_end]);
                    i = ep_end;
                    continue;
                }
            }
        }
        let ch = input[i..].chars().next().expect("índice em char boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn is_word_boundary_before(bytes: &[u8], idx: usize) -> bool {
    if idx == 0 {
        return true;
    }
    !bytes[idx - 1].is_ascii_alphanumeric()
}

/// `\s+(?:19|20)\d{2}\s*$` — só o ano do FIM.
fn strip_trailing_year(input: &str) -> String {
    let trimmed = input.trim_end();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 4 {
        return input.to_string();
    }
    let year_start = bytes.len() - 4;
    let year = &bytes[year_start..];
    if !(year[0] == b'1' || year[0] == b'2')
        || !(year[1] == b'9' || year[1] == b'0')
        || !year[2].is_ascii_digit()
        || !year[3].is_ascii_digit()
    {
        return input.to_string();
    }
    // Precisa de whitespace imediatamente antes do ano.
    if year_start == 0 || !bytes[year_start - 1].is_ascii_whitespace() {
        return input.to_string();
    }
    let mut cut = year_start;
    while cut > 0 && bytes[cut - 1].is_ascii_whitespace() {
        cut -= 1;
    }
    format!("{} ", &trimmed[..cut])
}

fn is_season_only(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 2 || b.len() > 3 {
        return false;
    }
    if b[0] != b'S' && b[0] != b's' {
        return false;
    }
    b[1..].iter().all(|c| c.is_ascii_digit())
}

fn collapse_spaces(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn br_tira_acento_e_episodio() {
        let shaped = shape_search_query("bludv-cardigann", "Extermínio S02E05", true, false);
        assert_eq!(shaped, "Exterminio S02");
    }

    #[test]
    fn global_colapsa_sigla_e_mantem_acento() {
        let shaped = shape_search_query("yts", "G.O.R.A. 2004", false, false);
        assert_eq!(shaped, "GORA 2004");
        let accent = shape_search_query("yts", "Extermínio", false, false);
        assert_eq!(accent, "Extermínio");
    }

    #[test]
    fn bare_title_tira_ano_final() {
        let shaped = shape_search_query("apachetorrent-cardigann", "Coringa 2019", true, true);
        assert_eq!(shaped, "Coringa");
    }

    #[test]
    fn so_temporada_volta_query_original() {
        let shaped = shape_search_query("bludv-cardigann", "S01", true, false);
        assert_eq!(shaped, "S01");
    }
}
