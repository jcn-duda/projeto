//! Porte de `hasPtSigns` e `brOriginMark` (`src/utils/br-origin.ts`), o
//! predicado de origem BR que protege acervo na limpeza da conta.
//!
//! O `/i` do JS (sem `u`) não é o case folding do Unicode. Ele compara
//! `Canonicalize(c)`: a maiúscula de um caractere, exceto quando a maiúscula é
//! ASCII e o original não é (assim `ſ` e `ı` NÃO casam com `s` e `i`). Por isso
//! o texto passa por `js_canon` e os padrões são escritos em maiúscula, sem
//! `(?i)`. Os `\b` são ASCII (`(?-u:\b)`), como no JS.

use std::sync::OnceLock;

use regex::Regex;

/// `Canonicalize` do JS sem a flag `u`, aplicado caractere a caractere.
pub(crate) fn js_canon(text: &str) -> String {
    // ASCII sobe para ASCII de um char só: a guarda abaixo nunca se aplica.
    if text.is_ascii() {
        return text.to_ascii_uppercase();
    }
    text.chars()
        .map(|c| {
            let mut up = c.to_uppercase();
            match (up.next(), up.next()) {
                (Some(u), None) if !((c as u32) >= 128 && (u as u32) < 128) => u,
                _ => c,
            }
        })
        .collect()
}

fn compile(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("padrão de origem BR compila"))
}

// `/[ãõ]/i` e `/ç/i`: acento de pt-BR, em maiúscula depois do canon.
fn accent_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, "[ÃÕÇ]")
}

// `PT_VOCAB`: vocabulário de post BR, com fronteira ASCII.
fn pt_vocab_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(
        &RE,
        "(?-u:\\b)(TEMPORADAS?|EPIS[OÓ]DIOS?|DUBLAD[OA]S?|DUBLAGEM|NACIONAL|COMPLET[OA]S?|COLE[CÇ][AÃ]O|VERS[OÕ]ES?|ESTENDID[OA]S?|GUERRA|MUNDIAL|ESTREIA|CAP[IÍ]TULOS?|CAMINHO|CIDADE|NOITE|VINGAN[CÇ]A|CORA[CÇ][AÃ]O|PAIX[AÃ]O|F[UÚ]RIA|SELVAGEM|ASSASSINO|ASSASSINA|MALDI[CÇ][AÃ]O)(?-u:\\b)",
    )
}

// `PT_STOP_TWO`: preposições e artigos. Precisa de 2 ocorrências.
fn pt_stop_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(
        &RE,
        "(?-u:\\b)(DAS?|DE|DOS?|N[AO]S?|UMAS?|PARA|COM|ENTRE|SOBRE|ATR[AÁ]S)(?-u:\\b)",
    )
}

// `BR_MARK` do ranking, e `BR_SITE_MARKS` da limpeza (acrescenta os dois
// domínios de The Pirate Filmes). As fronteiras de `bthd` ficam iguais.
const BR_MARK_ALTERNATION: &str = "COMANDOTORRENTS|BLUDV|NERDFILMES|TORRENTDOSFILMES|WOLVERDON|ANDRETPF|LAPUMIA|MEGATORRENTS|HDTORRENT|TORRENTBR|(?:^|[^A-Z0-9])BTHD(?:$|[^A-Z0-9])";

fn br_mark_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, &format!("(?:{BR_MARK_ALTERNATION})"))
}

fn br_site_marks_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(
        &RE,
        &format!("(?:{BR_MARK_ALTERNATION}|THEPIRATEFILMES|PIRATEFILMES)"),
    )
}

// `/\bfilmes?\b/i` da limpeza.
fn filmes_word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, "(?-u:\\b)FILMES?(?-u:\\b)")
}

/// `hasPtSigns`: sinal de português no título, sem marca de áudio.
pub fn has_pt_signs(title: &str) -> bool {
    has_pt_signs_canon(&js_canon(title))
}

/// `has_pt_signs` sobre o `js_canon` do título, já calculado.
pub(crate) fn has_pt_signs_canon(t: &str) -> bool {
    accent_re().is_match(t)
        || pt_vocab_re().is_match(t)
        || pt_stop_re().find_iter(t).count() >= 2
        || br_mark_re().is_match(t)
}

/// `brOriginMark`: origem BR pelo nome, para NÃO apagar. Marca de site, a
/// palavra "filme(s)" ou qualquer sinal de `hasPtSigns`.
pub fn br_origin_mark(title: &str) -> bool {
    let t = js_canon(title);
    br_origin_mark_canon(&t, has_pt_signs_canon(&t))
}

/// `br_origin_mark` sobre o `js_canon` do título, com o `has_pt_signs` dele.
pub(crate) fn br_origin_mark_canon(t: &str, has_pt_signs: bool) -> bool {
    br_site_marks_re().is_match(t) || filmes_word_re().is_match(t) || has_pt_signs
}
