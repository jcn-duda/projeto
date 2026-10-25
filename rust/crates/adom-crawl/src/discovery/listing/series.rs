//! IDENTIDADE DO PORTÃO DE SÉRIES no cursor de LISTAGEM.
//!
//! Porte de `crawl-listing-series.ts`. O cursor (página, âncora, `rounds`) mora
//! em [`crate::listing::cursor`] e este módulo NÃO o duplica: carrega o único
//! dado que a cobertura daquele cursor não expressa.
//!
//! ## O buraco que isto fecha
//!
//! A listagem de um site BR é MISTA: a mesma página tem card de filme e card de
//! série. Com séries desligadas, o `walk_listing` LÊ a página (o request foi
//! gasto no site) e DESCARTA a URL de série — a política certa, herdada dos
//! sites com sitemap. Só que a página também é CONSUMIDA pelo cursor
//! (`page + 1`, `seen + posts`, âncora). A partir daí aquelas páginas ficam
//! para trás do marco, e a âncora afirma que tudo abaixo dela já foi
//! enfileirado. Não foi: as URLs de série foram jogadas no caminho. Ligar
//! séries depois não recupera nada — só "Zerar site" recuperaria, e ele joga
//! fora também o que já foi enfileirado.
//!
//! ## Por que o portão ENTRA na identidade do cursor
//!
//! A cobertura do cursor é um RESUMO ("li até este post"), e o resumo só vale
//! para a varredura que o produziu. Cursor escrito com séries desligadas
//! descreve um mundo em que a série foi descartada; continuá-lo com séries
//! ligadas é afirmar cobertura que não existe. Quando o portão atual difere do
//! gravado, o cursor é APAGADO e a próxima rodada recomeça da página 1 — reler
//! é idempotente por `url_key`, e o que é irreversível é a PERDA.
//!
//! ## Marcador ausente = cursor de antes desta mudança
//!
//! Sem marcador o cursor é INCOMPATÍVEL e é descartado uma única vez (a `r1`
//! media o fim só pelos posts aceitos; um card pulado fez o Apache "terminar"
//! na página 211 de 2123). Cursor da `r1` ainda em carga (`sweep == false`)
//! com o MESMO portão segue de onde está: a carga não declarou cobertura.

use crate::listing::cursor::{listing_cursor_key, ListingCursor};
use crate::sitemap::CrawlPageKind;

/// Sufixo da chave irmã no `crawl_state`. Derivada da chave do cursor (e não
/// uma lista de sites) porque a identidade é a mesma: a mesma listagem, no
/// mesmo site, com o mesmo kind.
pub const LISTING_SERIES_SUFFIX: &str = ":series";

/// Versão da régua de fim de catálogo gravada junto do portão.
const RULE_VERSION: &str = "r2";

/// Chave do marcador de séries (irmã da chave do cursor).
pub fn listing_series_key(kind: CrawlPageKind, listing: &str) -> String {
    format!(
        "{}{LISTING_SERIES_SUFFIX}",
        listing_cursor_key(kind, listing)
    )
}

/// Valor do marcador: bit do portão + versão da régua (`1:r2` / `0:r2`).
pub fn marker_of(series_enabled: bool) -> String {
    format!("{}:{RULE_VERSION}", if series_enabled { "1" } else { "0" })
}

/// Resultado da leitura do cursor COM o portão.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateLoad {
    /// Cursor utilizável (`None` = a varredura recomeça da página 1).
    pub cursor: Option<ListingCursor>,
    /// O cursor gravado é incompatível e precisa ser APAGADO antes da próxima
    /// gravação (senão o estado velho é reencontrado).
    pub clear: bool,
}

/// Lê o cursor respeitando a identidade do portão de séries.
///
/// `saved` é o marcador gravado (`None`/vazio quando não existe). Sem cursor
/// não há o que comparar: a listagem já vai recomeçar da página 1.
pub fn load_with_gate(
    cursor: Option<ListingCursor>,
    saved: Option<&str>,
    series_enabled: bool,
) -> GateLoad {
    let Some(cursor) = cursor else {
        return GateLoad {
            cursor: None,
            clear: false,
        };
    };
    let saved = saved.unwrap_or("").trim();
    if saved == marker_of(series_enabled) {
        return GateLoad {
            cursor: Some(cursor),
            clear: false,
        };
    }
    let bit = if series_enabled { "1" } else { "0" };
    // Marcador da régua ANTERIOR (só o bit) com o MESMO portão: a carga em
    // andamento continua de onde está; a que já virou incremental pode ter
    // parado num fim falso e é refeita.
    if saved == bit && !cursor.sweep {
        return GateLoad {
            cursor: Some(cursor),
            clear: false,
        };
    }
    GateLoad {
        cursor: None,
        clear: true,
    }
}
