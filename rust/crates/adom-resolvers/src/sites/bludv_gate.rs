//! Portão de anúncio do BLUDV — a ÚNICA detecção do site no port (Fase 4).
//!
//! POR QUE EXISTE: o BLUDV trocou o protetor de link por um portão que exige
//! ver/clicar um anúncio. Com o portão ativo o post deixa de publicar os links
//! `systemads`/`videosad`; o resolvedor devolve 0 releases e o operador não tem
//! como distinguir "o site mudou de layout" de "o site não tem esse título".
//! A detecção converte esse silêncio em motivo.
//!
//! POR QUE MORA EM MÓDULO PRÓPRIO: é o espelho exato de
//! `resolvers/profiles/bludv-gate.ts`. O TS tem uma regex só para dois
//! consumidores (resolvedor standalone e provider em processo) e este port é o
//! terceiro; manter a cópia dentro de `bludv.rs` era o jeito certo de deixar os
//! lados divergirem em silêncio. Mudou aqui, muda lá.
//!
//! ASSINATURA (medida ao vivo em 2026-10-13 pelo FlareSolverr do container, em
//! `https://bludvfilmes1.xyz`; a medição direta sem solvedor é HTTP 403):
//!
//!   `<a href="https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609"`
//!   `class="customButton" rel="noopener noreferrer" target="_blank">`
//!   `Magnet-Link<div class="eas-video-overlay-wrapper"> ... </div></a>`
//!
//! O post renderizado pelo browser do solvedor traz as DUAS formas, o que
//! invalidou a regex antiga (`...Magnet-Link\s*</a>`): em 2 de 4 posts
//! capturados o rótulo é seguido pelo overlay do player injetado, não por `</a>`.
//! Parar no `\b` depois do rótulo casa as duas. O `\b` do JS vira `(?-u:\b)` no
//! crate `regex` (mesma regra de paridade usada no resto do port).

use std::sync::LazyLock;

use regex::Regex;

/// Botão "Magnet-Link" cujo href leva ao hub de anúncio.
///
/// O `[^"']*` depois de `/gate/go/` come o hash e o `?p=` do post (a forma real
/// é `/gate/go/<16 hex>?p=<id>`, não `/gate/go/?post=NNNN` como descrevia o
/// plano); o `(?-u:\b)` final tolera o overlay injetado sem aceitar rótulo
/// colado em outra palavra.
static AD_GATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)<a(?-u:\b)[^>]*href\s*=\s*["'][^"']*/gate/go/[^"']*["'][^>]*>\s*Magnet-Link(?-u:\b)"#,
    )
    .expect("regex do portão de anúncio do bludv")
});

/// Mensagem única do erro — é o que o log do drop e o 502 do `/resolve` mostram.
pub const AD_GATE_REASON: &str = "bludv: portão de anúncio";

/// O HTML publica o botão do portão? (medição; não é a decisão)
pub fn has_ad_gate(html: &str) -> bool {
    AD_GATE_RE.is_match(html)
}

/// Porta de bloqueio: `Err` quando o post está no portão — nenhum botão
/// aproveitável sobrou (`usable_links == 0`) E o HTML publica o botão do portão.
///
/// A ordem importa: um post com protetor direto E portão serve as releases
/// boas; errorizar nele faria o detector comer resultado que funciona.
pub fn assert_blocked(html: &str, usable_links: usize) -> Result<(), String> {
    if usable_links > 0 {
        return Ok(());
    }
    if has_ad_gate(html) {
        return Err(AD_GATE_REASON.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Forma real capturada em 2026-10-13 (`batman-a-queda-do-morcego`): o
    /// overlay do player entra dentro do `<a>`, então nada fecha após o rótulo.
    const WITH_OVERLAY: &str = r#"<a href="https://bludvfilmes1.xyz/gate/go/38a7e919c6e717de?p=80753" class="customButton" rel="noopener noreferrer" target="_blank">Magnet-Link<div class="eas-video-overlay-wrapper" style="position: absolute; top: 0px; left: 0px;"><div class="eas-video-overlay-container"></div></div></a>"#;

    /// Forma real capturada no mesmo dia (`batman-cruzado-encapuzado`): sem
    /// overlay injetado, o `<a>` fecha direto após o rótulo.
    const PLAIN: &str = r#"<a href="https://bludvfilmes1.xyz/gate/go/f1d9d62d0c5cc562?p=80137" class="customButton" rel="noopener noreferrer" target="_blank">Magnet-Link</a>"#;

    #[test]
    fn casa_as_duas_formas_reais_do_botao() {
        for html in [WITH_OVERLAY, PLAIN] {
            assert!(has_ad_gate(html), "o portão real não foi casado");
            assert_eq!(assert_blocked(html, 0), Err(AD_GATE_REASON.into()));
        }
    }

    #[test]
    fn nao_erra_post_que_ainda_serve() {
        // Botão aproveitável presente: o portão ao lado não derruba o post.
        assert!(assert_blocked(WITH_OVERLAY, 3).is_ok());
        assert!(assert_blocked(PLAIN, 1).is_ok());
    }

    #[test]
    fn nao_casa_protetor_verdadeiro() {
        // Estes são os links que o post PUBLICA quando o portão não está ativo;
        // confundir os dois transformaria um resultado bom em erro.
        for html in [
            r#"<a href="https://systemads1.com/go/aaa111">Magnet-Link</a>"#,
            r#"<a href="https://videosad.net/go/ccc333">Magnet-Link</a>"#,
            r#"<a href="https://bludvfilmes1.xyz/gate/gox/?p=1">Magnet-Link</a>"#,
            // O decoy real do post capturado: mesmo rótulo, href do site.
            r#"<a href="/" class="customButton" rel="noopener noreferrer">Magnet-Link<div class="eas-video-overlay-wrapper"></div></a>"#,
        ] {
            assert!(!has_ad_gate(html), "falso positivo em {html}");
            assert!(assert_blocked(html, 0).is_ok());
        }
    }
}
