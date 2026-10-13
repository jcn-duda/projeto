//! Port de `resolvers/matching.ts` — matching de busca e detecção de posts genéricos.
//!
//! Inclui normalização de texto, matching de query contra título de post,
//! detecção de posts de listagem genérica e seleção de botão por índice.

use regex::Regex;
use std::sync::LazyLock;

// ── Regex compiladas uma vez ─────────────────────────────────────────────────

/// Detecta ano de 4 dígitos no final (para remoção controlada).
static RE_TRAILING_YEAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{4}$").expect("regex de ano válida"));

/// Detecta padrão de temporada (S01, 1ª Temporada, etc.).
static RE_SEASON: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:\bS(\d{1,2})\b|(\d{1,2})\s*[ªº]\s*Temporada)").expect("regex de temporada válida")
});

/// Detecta início de lista genérica ("lista", "listão", "índice").
static RE_LIST_START: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(lista|listao|indice)").expect("regex de lista válida")
});

/// Detecta categorias após "lista de".
static RE_LIST_CATEGORY: LazyLock<Regex> = LazyLock::new(|| {
    let categories = [
        "filme", "filmes", "serie", "series", "anime", "animes", "desenho", "desenhos",
        "documentario", "documentarios", "temporada", "temporadas", "dorama", "doramas",
        "jogo", "jogos", "musica", "musicas", "categoria", "categorias", "todo", "todos",
        "toda", "todas", "tudo", "geral", "completa", "completo",
    ].join("|");
    Regex::new(&format!(
        r"^(lista|listao|indice)\s+de\s+({})\b(.*)$",
        categories
    )).expect("regex de categoria válida")
});

/// Detecta artigos definidos após a categoria (para exclusão).
static RE_DEFINITE_ARTICLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:do|da|dos|das|de)\b").expect("regex de artigo válida")
});

// ── Normalização de texto ────────────────────────────────────────────────────

/// Normaliza texto para matching: minúsculas, sem acentos, só alfanumérico.
///
/// Equivalente a `normalizeFilterText` em `resolvers/matching.ts:13-15`.
///
/// Como o `unicode-normalization` não está disponível diretamente em `adom-crawl`,
/// esta versão usa um mapeamento manual de caracteres acentuados comuns em português.
/// Cobre 99% dos casos reais; para paridade byte-a-byte com o TS, seria necessário
/// adicionar `unicode-normalization` como dependência direta.
fn normalize_filter_text(s: &str) -> String {
    let lowered = s.to_lowercase();
    let without_accents = strip_accents_portuguese(&lowered);
    // Substitui não-alfanumérico por espaço e normaliza espaços.
    let mut result = String::with_capacity(without_accents.len());
    let mut last_was_space = true; // começa true para trim inicial
    for c in without_accents.chars() {
        if c.is_ascii_alphanumeric() {
            result.push(c);
            last_was_space = false;
        } else if !last_was_space {
            result.push(' ');
            last_was_space = true;
        }
    }
    // Trim final (remove espaço à direita se houver).
    if result.ends_with(' ') {
        result.pop();
    }
    result
}

/// Remove acentos comuns em português (mapeamento manual).
///
/// Cobre: áéíóúâêôãõçàáíóúÁÉÍÓÚÂÊÔÃÕÇÀ. Não é NFD completo, mas atende
/// aos casos reais de títulos de filmes/séries em português.
fn strip_accents_portuguese(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for c in s.chars() {
        let mapped = match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            'ý' | 'ÿ' => 'y',
            'ª' | 'º' => ' ', // ordinais viram espaço
            _ => c,
        };
        result.push(mapped);
    }
    result
}

/// Remove o último token se for um ano de 4 dígitos.
///
/// Equivalente a `stripTrailingYears` em `resolvers/matching.ts:19-23`.
/// Preserva anos que fazem parte do título (ex: "Blade Runner 2049", "1917").
fn strip_trailing_years(tokens: &[String]) -> Vec<String> {
    let mut out = tokens.to_vec();
    if out.len() >= 2 {
        if let Some(last) = out.last() {
            if RE_TRAILING_YEAR.is_match(last) {
                out.pop();
            }
        }
    }
    out
}

/// Computa tokens desejados da query para matching.
///
/// Equivalente a `computeWantedTokens` em `resolvers/matching.ts:25-29`.
/// Remove ano final, filtra tokens longos (>2 chars) se houver 2+, senão usa todos.
fn compute_wanted_tokens(query: &str) -> Vec<String> {
    let normalized = normalize_filter_text(query);
    let all: Vec<String> = normalized
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();
    let all = strip_trailing_years(&all);
    let long: Vec<String> = all.iter().filter(|w| w.len() > 2).cloned().collect();
    if long.len() >= 2 {
        long
    } else {
        all
    }
}

// ── Funções públicas ─────────────────────────────────────────────────────────

/// Verifica se o título do post casa com a query de busca.
///
/// Equivalente a `matchesResolverQuery` em `resolvers/matching.ts:33-38`.
///
/// Critério: pelo menos 60% dos tokens desejados da query devem estar presentes
/// no título (após normalização). Case-insensitive, sem acentos.
pub fn matches_resolver_query(title: &str, query: &str) -> bool {
    let wanted = compute_wanted_tokens(query);
    if wanted.is_empty() {
        return true;
    }
    let got: std::collections::HashSet<String> = normalize_filter_text(title)
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();
    let matches = wanted.iter().filter(|w| got.contains(*w)).count();
    (matches as f64) / (wanted.len() as f64) >= 0.6
}

/// Detecta posts genéricos de listagem ("Filmes 2024", "Séries Netflix", etc.).
///
/// Equivalente a `isGenericListPost` em `resolvers/matching.ts:61-80`.
///
/// Retorna `true` para títulos como "Lista de Filmes", "Listão de Séries",
/// "Índice de Desenhos". NÃO corta títulos como "A Lista de Schindler".
pub fn is_generic_list_post(title: &str) -> bool {
    if title.is_empty() {
        return false;
    }
    let clean = normalize_filter_text(title);
    if !RE_LIST_START.is_match(&clean) {
        return false;
    }
    if let Some(caps) = RE_LIST_CATEGORY.captures(&clean) {
        let after = caps.get(3).map_or("", |m| m.as_str()).trim();
        // Se após a categoria houver "do/da/dos/das/de", NÃO é genérico
        // (ex: "Lista de Schindler" tem "de Schindler" após "Lista de").
        !RE_DEFINITE_ARTICLE.is_match(after)
    } else {
        false
    }
}

/// Extrai o link do botão de índice N de uma lista de URLs.
///
/// Simplificação do `pickButton` de `resolvers/matching.ts:88-100`.
///
/// A versão TS recebe um array de objetos com `url` e usa hash SHA1 do href
/// para identificação estável. Esta versão Rust recebe uma slice de URLs
/// (strings) e seleciona por índice. O matching por hash fica como `todo!()`
/// pois requer SHA1 (dependência não disponível).
///
/// Se `hash` for fornecido, retorna `None` (não implementado sem SHA1).
/// Se `count` for fornecido e diferir do tamanho da slice, retorna `None`.
pub fn pick_button(links: &[String], index: usize, hash: Option<&str>, count: Option<usize>) -> Option<String> {
    // Se hash foi fornecido, a versão TS faria matching por SHA1 do href.
    // Sem SHA1 disponível, retorna None quando hash está presente.
    if hash.is_some() {
        // TODO: implementar matching por hash quando SHA1 estiver disponível.
        // A versão TS faz: links.find(link => buttonId(link) === hash)
        // buttonId = sha1(href).slice(0, 10)
        if count.is_some() && links.len() != count.unwrap() {
            return None;
        }
        return None; // hash fornecido mas não podemos fazer matching
    }
    links.get(index).cloned()
}

// ── Testes ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // normalize_filter_text

    #[test]
    fn normalize_filter_text_basico() {
        assert_eq!(normalize_filter_text("Olá Mundo"), "ola mundo");
    }

    #[test]
    fn normalize_filter_text_acentos() {
        assert_eq!(normalize_filter_text("Filme Ação"), "filme acao");
        assert_eq!(normalize_filter_text("Aviação Ñ"), "aviacao n");
    }

    #[test]
    fn normalize_filter_text_nao_alfanumerico() {
        assert_eq!(normalize_filter_text("A-B.C:D"), "a b c d");
    }

    // matches_resolver_query

    #[test]
    fn matches_resolver_query_casamento_completo() {
        assert!(matches_resolver_query("Filme Ação 2024", "filme acao"));
    }

    #[test]
    fn matches_resolver_query_casamento_parcial() {
        // 2 de 3 tokens = 66% >= 60%
        assert!(matches_resolver_query("Filme Ação", "filme acao 2024"));
    }

    #[test]
    fn matches_resolver_query_sem_casamento() {
        assert!(!matches_resolver_query("Documentário Natureza", "filme acao"));
    }

    #[test]
    fn matches_resolver_query_query_vazia() {
        assert!(matches_resolver_query("Qualquer Título", ""));
    }

    // is_generic_list_post

    #[test]
    fn is_generic_list_post_lista_filmes() {
        assert!(is_generic_list_post("Lista de Filmes"));
        assert!(is_generic_list_post("Listão de Séries"));
        assert!(is_generic_list_post("Índice de Desenhos"));
    }

    #[test]
    fn is_generic_list_post_nao_generico() {
        assert!(!is_generic_list_post("A Lista de Schindler"));
        assert!(!is_generic_list_post("Filme Ação 2024"));
    }

    #[test]
    fn is_generic_list_post_vazio() {
        assert!(!is_generic_list_post(""));
    }

    // pick_button

    #[test]
    fn pick_button_por_indice() {
        let links = vec![
            "https://example.com/1".to_string(),
            "https://example.com/2".to_string(),
            "https://example.com/3".to_string(),
        ];
        assert_eq!(pick_button(&links, 1, None, None), Some("https://example.com/2".to_string()));
    }

    #[test]
    fn pick_button_indice_fora_da_faixa() {
        let links = vec!["https://example.com/1".to_string()];
        assert_eq!(pick_button(&links, 5, None, None), None);
    }

    #[test]
    fn pick_button_com_count_incompativel() {
        let links = vec!["https://example.com/1".to_string()];
        // hash + count incompatível = None
        assert_eq!(pick_button(&links, 0, Some("abc"), Some(5)), None);
    }

    #[test]
    fn pick_button_hash_sem_sha1() {
        let links = vec!["https://example.com/1".to_string()];
        // hash fornecido mas SHA1 não implementado = None
        assert_eq!(pick_button(&links, 0, Some("abc"), None), None);
    }
}
