//! Cursor durável da LISTAGEM paginada (fase 6, trilha de listing).
//!
//! Porte de `crawl-cursor.ts` (`ListingCursor`), com as mesmas decisões:
//!
//! - **A listagem é uma janela deslizante**, não um acervo declarado: o fim é
//!   um FATO OBSERVADO (página calcanhar) e a retomada precisa de um marco.
//! - **`page + 1` sozinho não basta.** A listagem cresce pela frente, então o
//!   que prova "li até aqui" é a ÂNCORA (o post mais antigo já lido, guardado
//!   pelo CAMINHO para sobreviver à troca de domínio). No modo incremental ela
//!   é a parada da passada; na carga inicial ela é diagnóstico.
//! - **Token versionado (`lc1.<base64url>`)** com leitura ESTRITA: fora de
//!   forma é `None` (a página 1 é o lado barato), nunca adoção de lixo.
//!
//! O cursor do SITEMAP (`cursor:movie`) é outro: aquele corta por data, este
//! por posição + âncora. Não misture as chaves.

use serde::{Deserialize, Serialize};

use crate::listing::base64url;
use crate::sitemap::CrawlPageKind;
use crate::store::url_key::crawl_url_key;

/// Prefixo/versão do token. Trocar a versão invalida os tokens antigos.
pub const LISTING_CURSOR_TAG: &str = "lc1";
/// Estado do operador, não entrada de usuário: o limite existe para um
/// `crawl_state` corrompido não virar parse caro.
const LISTING_CURSOR_MAX_LEN: usize = 1024;
/// Teto de páginas por RODADA (0 desliga o teto no chamador). Dimensionado
/// contra o teto por hora do motor; o knob de ambiente fica FORA daqui porque
/// este módulo é puro e não lê config.
pub const LISTING_ROUND_MAX_PAGES: u32 = 20;

/// Onde a listagem parou. `page` é 1-based: a primeira página a ler é 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListingCursor {
    /// Site dono — o estado já é escopado por site, mas o token viaja sozinho.
    pub site: String,
    pub kind: CrawlPageKind,
    /// Caminho raiz da listagem (identidade, sem query).
    pub path: String,
    /// Página a ler na retomada (1-based).
    pub page: u32,
    /// Posts já lidos desta listagem (orçamento já gasto).
    pub seen: u64,
    /// ÂNCORA: caminho do post mais antigo já lido. `""` = nenhum.
    pub anchor: String,
    /// Páginas já lidas no round em curso (zera quando o round fecha).
    pub round_page: u32,
    /// Modo INCREMENTAL: a passada começa na página 1 e fecha ao reencontrar
    /// a `anchor`. `false` = carga inicial (a âncora não vale).
    pub sweep: bool,
    /// Post mais NOVO visto na página 1 no início da passada.
    pub head: Option<String>,
    /// Rounds fechados (diagnóstico; não decide retomada).
    pub rounds: u64,
    /// Última gravação (diagnóstico; não decide retomada).
    pub updated_at: i64,
}

/// Cursor zerado — "nunca li esta listagem".
pub fn start_listing_cursor(
    site: &str,
    kind: CrawlPageKind,
    listing: &str,
    now: i64,
) -> ListingCursor {
    ListingCursor {
        site: site.to_string(),
        kind,
        path: crawl_url_key(listing),
        page: 1,
        seen: 0,
        anchor: String::new(),
        round_page: 0,
        sweep: false,
        head: None,
        rounds: 0,
        updated_at: now,
    }
}

/// Chave durável da listagem no `crawl_state`. Aceita URL ou caminho: a
/// normalização do `crawl_url_key` torna as duas a mesma chave.
pub fn listing_cursor_key(kind: CrawlPageKind, listing: &str) -> String {
    format!("listing:{}:{}", kind.as_str(), crawl_url_key(listing))
}

/// O round já leu o que podia? O chamador PARA de buscar páginas aqui.
pub fn listing_round_exhausted(cursor: &ListingCursor, round_max_pages: u32) -> bool {
    round_max_pages > 0 && cursor.round_page >= round_max_pages
}

/// A listagem acabou para este ciclo? `max_pages == 0` não limita.
pub fn listing_cursor_exhausted(cursor: &ListingCursor, max_pages: u32) -> bool {
    max_pages > 0 && cursor.page > max_pages
}

/// Reinicia o round em curso sem tocar no marco nem na posição — recuperação
/// de `round_page` incoerente. Sem isto a listagem pararia para sempre, porque
/// nada mais fecharia o round.
pub fn restart_listing_round(cursor: &ListingCursor, now: i64) -> ListingCursor {
    ListingCursor {
        round_page: 0,
        updated_at: now,
        ..cursor.clone()
    }
}

/// Forma serializada do token (nomes curtos, como o TS grava).
#[derive(Debug, Serialize, Deserialize)]
struct Token {
    v: u32,
    s: String,
    k: String,
    p: String,
    n: u64,
    c: u64,
    #[serde(default)]
    a: Option<String>,
    #[serde(default)]
    r: Option<u64>,
    #[serde(default)]
    d: Option<u64>,
    t: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    w: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    h: Option<String>,
}

/// Serializa o cursor no token durável.
pub fn encode_listing_cursor(cursor: &ListingCursor) -> String {
    let token = Token {
        v: 1,
        s: cursor.site.clone(),
        k: cursor.kind.as_str().to_string(),
        p: crawl_url_key(&cursor.path),
        n: u64::from(cursor.page.max(1)),
        c: cursor.seen,
        a: Some(cursor.anchor.clone()),
        r: Some(u64::from(cursor.round_page)),
        d: Some(cursor.rounds),
        t: cursor.updated_at.max(0) as u64,
        w: cursor.sweep.then_some(1),
        h: cursor.head.clone(),
    };
    let json = serde_json::to_string(&token).unwrap_or_else(|_| "{}".to_string());
    format!(
        "{LISTING_CURSOR_TAG}.{}",
        base64url::encode(json.as_bytes())
    )
}

/// `None` para qualquer coisa fora de forma — nunca lança, nunca adota lixo.
pub fn decode_listing_cursor(token: &str) -> Option<ListingCursor> {
    let text = token.trim();
    if text.is_empty() || text.len() > LISTING_CURSOR_MAX_LEN {
        return None;
    }
    let (tag, body) = text.split_once('.')?;
    if tag != LISTING_CURSOR_TAG {
        return None;
    }
    let bytes = base64url::decode(body)?;
    let parsed: Token = serde_json::from_slice(&bytes).ok()?;
    if parsed.v != 1 {
        return None;
    }
    let kind = match parsed.k.as_str() {
        "movie" => CrawlPageKind::Movie,
        "tv_show" => CrawlPageKind::TvShow,
        _ => return None,
    };
    let path = crawl_url_key(&parsed.p);
    if parsed.s.trim().is_empty() || path.is_empty() || path == "/" {
        return None;
    }
    if parsed.n < 1 {
        return None;
    }
    let page = u32::try_from(parsed.n).ok()?;
    let anchor = parse_anchor(parsed.a.as_deref())?;
    let round_page = u32::try_from(parsed.r.unwrap_or(0)).ok()?;
    let rounds = parsed.d.unwrap_or(0);
    let updated_at = i64::try_from(parsed.t).ok()?;
    let head = parse_anchor(parsed.h.as_deref())?;
    Some(ListingCursor {
        site: parsed.s,
        kind,
        path,
        page,
        seen: parsed.c,
        anchor,
        round_page,
        sweep: parsed.w == Some(1),
        head: (!head.is_empty()).then_some(head),
        rounds,
        updated_at,
    })
}

/// Âncora vinda do token: `Some("")` quando AUSENTE (token gravado antes de a
/// âncora existir é "sem marco", não token ruim) e `None` quando PRESENTE e
/// inútil (corrupção: recomeçar a listagem é o lado barato).
fn parse_anchor(value: Option<&str>) -> Option<String> {
    let Some(text) = value else {
        return Some(String::new());
    };
    if text.trim().is_empty() {
        return Some(String::new());
    }
    let key = crawl_url_key(text);
    if key.is_empty() || key == "/" {
        return None;
    }
    Some(key)
}

#[cfg(test)]
#[path = "tests_cursor.rs"]
mod tests;
