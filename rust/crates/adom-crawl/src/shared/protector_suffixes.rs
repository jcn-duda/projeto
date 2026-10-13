//! Sufixos de protetor de link compartilhados entre o raspador (adom-crawl)
//! e os futuros resolvers BR (adom-resolvers).
//!
//! Fonte única: ambos os binários consultam esta lista em vez de manter
//! cópias próprias. Perfis podem adicionar sufixos extras via
//! `EXTRA_ALLOWED_PROTECTORS` (config do operador), mas a base é esta.

/// Sufixos de domínio de protetores de link conhecidos.
/// Usados para validar URLs de salto no protetor e para descobrir
/// a próxima URL no HTML (discover_next_url).
///
/// Unificados de `profile_parsers::download::BASE_PROTECTOR_SUFFIXES` e
/// `site_profiles::config::BASE_PROTECTOR_SUFFIXES` (eram idênticos).
/// O sufixo `systemtech.space` é extra do site VacaTorrent — os futuros
/// resolvers que o encontrem podem consultá-lo via
/// `VACA_EXTRA_PROTECTOR_SUFFIXES` neste mesmo módulo.
pub const PROTECTOR_SUFFIXES: &[&str] = &[
    "systemads1.com",
    "systemads.net",
    "videosad.net",
    "canalfutebol.com",
    "temreceita.com",
];

/// Sufixos extras específicos do VacaTorrent (base + estes).
/// Separados para que resolvers que não são do Vaca usem apenas a base.
pub const VACA_EXTRA_PROTECTOR_SUFFIXES: &[&str] = &[
    "systemtech.space",
];

/// Verifica se um hostname é um protetor conhecido (base comum).
///
/// Aceita correspondência exata ou como subdomínio (`.ends_with`).
/// Ex.: `is_protector_host("cdn.systemads1.com")` → `true`.
pub fn is_protector_host(hostname: &str) -> bool {
    let h = hostname.to_lowercase();
    PROTECTOR_SUFFIXES
        .iter()
        .any(|s| h == *s || h.ends_with(&format!(".{s}")))
}

/// Verifica se um hostname é protetor do VacaTorrent (base + extras do site).
pub fn is_vaca_protector_host(hostname: &str) -> bool {
    if is_protector_host(hostname) {
        return true;
    }
    let h = hostname.to_lowercase();
    VACA_EXTRA_PROTECTOR_SUFFIXES
        .iter()
        .any(|s| h == *s || h.ends_with(&format!(".{s}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_cobre_todos_os_sufixos() {
        for suffix in PROTECTOR_SUFFIXES {
            assert!(is_protector_host(suffix), "{suffix}");
            assert!(
                is_protector_host(&format!("cdn.{suffix}")),
                "sub.{suffix}"
            );
        }
    }

    #[test]
    fn vaca_inclui_extra() {
        assert!(is_vaca_protector_host("systemtech.space"));
        assert!(is_vaca_protector_host("cdn.systemtech.space"));
        // Base também passa pelo checker do Vaca.
        assert!(is_vaca_protector_host("systemads1.com"));
    }

    #[test]
    fn desconhecido_nao_e_protector() {
        assert!(!is_protector_host("example.com"));
        assert!(!is_protector_host("google.com"));
        assert!(!is_vaca_protector_host("example.com"));
    }

    #[test]
    fn systemtech_nao_e_base() {
        // Extra do Vaca NÃO está na base comum.
        assert!(!is_protector_host("systemtech.space"));
    }
}
