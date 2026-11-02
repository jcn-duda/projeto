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
///
/// `mundgostoso.site` é a 2ª metade da cadeia desde out/2026 (medido em
/// 2026-10-24): `relay.php` → `mundgostoso.site/enc/receber.php` → artigo com
/// contagem (`var URL_ETAPA2`) → `enc2/receber.php` → página com o magnet em
/// `<body data-link="base64">`. Fora desta lista a etapa 2 era recusada e todo
/// `/resolve` do Vaca acabava em "sem magnet no HTML final".
pub const VACA_EXTRA_PROTECTOR_SUFFIXES: &[&str] = &["systemtech.space", "mundgostoso.site"];

/// Hosts do próprio Vaca. Espelham `candidate_hosts` do registro de sites.
pub const VACA_SITE_HOSTS: &[&str] = &[
    "vaqueirofilmes.com",
    "vaqueirofilmes1.com",
    "vacatorrentmov.com",
];

/// Caminho da cadeia do protetor no PRÓPRIO site (`/enc/`, `/enc1/`, `/enc2/`):
/// medido em 2026-11-02, a cadeia saiu de `systemtech.space` para o host do Vaca.
/// O host sozinho não basta, porque o site inteiro também mora nele.
pub fn is_vaca_own_chain(hostname: &str, path: &str) -> bool {
    let host = hostname.to_lowercase();
    if !VACA_SITE_HOSTS.contains(&host.as_str()) {
        return false;
    }
    path.strip_prefix("/enc")
        .map(|rest| rest.trim_start_matches(|c: char| c.is_ascii_digit()))
        .is_some_and(|rest| rest.starts_with('/'))
}

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
            assert!(is_protector_host(&format!("cdn.{suffix}")), "sub.{suffix}");
        }
    }

    #[test]
    fn cadeia_propria_exige_host_do_site_e_caminho_enc() {
        assert!(is_vaca_own_chain("vaqueirofilmes.com", "/enc/go.php"));
        assert!(is_vaca_own_chain(
            "VAQUEIROFILMES1.com",
            "/enc2/receber.php"
        ));
        assert!(!is_vaca_own_chain("vaqueirofilmes.com", "/pt/movie/x/"));
        assert!(!is_vaca_own_chain("vaqueirofilmes.com", "/encontro/"));
        assert!(!is_vaca_own_chain("malicioso.example", "/enc/go.php"));
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
