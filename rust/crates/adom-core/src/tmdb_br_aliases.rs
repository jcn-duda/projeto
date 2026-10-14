//! Porte de `filterBrAliases` e da constante `MAX_BR_ALIASES`
//! (`src/utils/tmdb-br-aliases.ts`).
//!
//! Escopo desta fatia: SÓ o filtro PURO dos aliases BR. A outra exportação,
//! `fetchBrAliases`, fica de fora porque não é pura: lê `config.tmdb.apiKey`,
//! chama `Date.now()` e faz rede (`fetchJsonWithin`). Efeito de I/O não pertence
//! ao núcleo.
//!
//! `significantTokens` (helper privado, como no TS) e `filterBrAliases`
//! compõem o contrato. Um alias só entra se CONTIVER todas as palavras
//! significativas de algum nome canônico — "Operação: Lioness" é "Lioness"
//! acrescido do marketing BR. Palavra em comum não basta: "Kill" divide "kill"
//! com "Django Kill… If You Live, Shoot!" e abriria release de outra obra.
//! Alias cuja forma normalizada já é a de um canônico (ou de um alias anterior)
//! também sai, porque não acrescenta. O teto é `MAX_BR_ALIASES`.
//!
//! Palavra significativa = token de MAIS de 2 unidades UTF-16 (`t.length` do
//! JS, não `chars().count()`), fora de `LEADING_ARTICLES` e que não seja só
//! dígitos ASCII (`/^\d+$/` do JS opera sobre `[0-9]`, sem flag `u`). Os tokens
//! vêm de `title_tokens` (normalização compartilhada) e o `trim` do candidato é
//! o `js_trim` do crate.
//!
//! `candidates` e `canonical` são listas de `Option<&str>`: no TS o runtime faz
//! `String(raw || '')` e `canonical.filter(Boolean)`, então `None`/`""` são o
//! `null`/`undefined`/vazio e nada mais é coagido (sem `String` de número/objeto).

use std::collections::HashSet;

use crate::js_text::js_trim;
use crate::matching_vocabulary::{leading_articles, title_tokens};

/// Teto de aliases por obra — mesmo do provider BR Dublado (`kBrDubMaxTmdbAliases`).
pub const MAX_BR_ALIASES: usize = 2;

/// `token.length` do JS: comprimento em unidades UTF-16, não em `char`s. Um
/// caractere astral conta 2; é o que decide o `> 2` do filtro.
fn utf16_len(token: &str) -> usize {
    token.encode_utf16().count()
}

/// `/^\d+$/.test(token)` do JS: `\d` sem flag `u` é `[0-9]` ASCII, exigindo ao
/// menos um dígito e nenhum outro byte.
fn is_ascii_digits(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| b.is_ascii_digit())
}

/// `significantTokens(text)`: tokens de mais de 2 unidades UTF-16, fora dos
/// artigos iniciais e que não sejam só dígitos ASCII.
fn significant_tokens(text: &str) -> Vec<String> {
    title_tokens(text)
        .into_iter()
        .filter(|t| {
            utf16_len(t) > 2 && !leading_articles().contains(t.as_str()) && !is_ascii_digits(t)
        })
        .collect()
}

/// `filterBrAliases(candidates, canonical)`: os aliases aceitos, no máximo
/// `MAX_BR_ALIASES`, na ordem dos candidatos.
///
/// `None`/`""` são `null`/`undefined`/vazio, nunca um valor a coagir. O
/// `canonical` conserva o valor CRU aceito (com espaços), como no TS.
pub fn filter_br_aliases(candidates: &[Option<&str>], canonical: &[Option<&str>]) -> Vec<String> {
    // `canonical.filter(Boolean)`: `None`/`""` caem; o resto (inclusive espaço) fica.
    let truthy: Vec<&str> = canonical
        .iter()
        .copied()
        .flatten()
        .filter(|n| !n.is_empty())
        .collect();

    // Só os canônicos com alguma palavra significativa podem admitir alias.
    let canon_sets: Vec<Vec<String>> = truthy
        .iter()
        .map(|n| significant_tokens(n))
        .filter(|toks| !toks.is_empty())
        .collect();

    // Forma normalizada de cada canônico: um alias igual a ela não acrescenta.
    let canon_norm: HashSet<String> = truthy.iter().map(|n| title_tokens(n).join(" ")).collect();

    let mut out: Vec<String> = Vec::new();
    for raw in candidates {
        let title = js_trim(raw.unwrap_or(""));
        if title.is_empty() {
            continue;
        }
        let norm = title_tokens(title).join(" ");
        if norm.is_empty()
            || canon_norm.contains(&norm)
            || out.iter().any(|o| title_tokens(o).join(" ") == norm)
        {
            continue;
        }
        let own: HashSet<String> = significant_tokens(title).into_iter().collect();
        if !canon_sets
            .iter()
            .any(|toks| toks.iter().all(|t| own.contains(t.as_str())))
        {
            continue;
        }
        out.push(title.to_string());
        if out.len() >= MAX_BR_ALIASES {
            break;
        }
    }
    out
}
