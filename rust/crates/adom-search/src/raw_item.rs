//! Item CRU da coleta — a entrada do BUILD da lista (porte do `RawItem` de
//! `types/domain.d.ts`, limitado ao que o construtor lê).
//!
//! A janela de coleta (`collection_window`) é genérica em `T`; o build consome
//! `Vec<RawItem>`. Campos `_*` do TS NÃO existem aqui: `is_br` é CAMPO
//! (invariante 2 — origem BR nunca é regex de título como única fonte) e a
//! marca de pack multiobra admitido é refeita a cada build (o lote cru vem do
//! cache `raw:v1`, compartilhado; mutá-lo persistiria estado — o TS clona).

use adom_core::{extract_info_hash, magnet_display_name};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawItem {
    /// Título da release (Jackett/BR/índice).
    pub title: Option<String>,
    /// `Title` — variação que algumas fontes mandam.
    pub title_pascal: Option<String>,
    pub magnet: Option<String>,
    pub magnet_uri: Option<String>,
    pub guid: Option<String>,
    /// btih cru (pode vir com `magnet:?xt=...`).
    pub info_hash: Option<String>,
    /// `PublishDate` em ms desde a época (quando a fonte publica).
    pub published_at: Option<f64>,
    /// Seeders publicados. Fonte BR manda placeholder (`1`) — nunca corte por
    /// isto antes do debrid (invariante 3).
    pub seeders: Option<f64>,
    /// Tamanho em bytes quando medido (`fsz`/cabeçalho).
    pub size_bytes: Option<f64>,
    /// Id do indexer/fonte (rótulo da coluna e teto por indexer).
    pub indexer: Option<String>,
    /// Lista `tracker:...` do item P2P.
    pub sources: Vec<String>,
    /// ORIGEM BR é campo (`isBr` do provider); `looks_pt_br` também liga.
    pub is_br: bool,
    /// Item do inventário da conta do debrid.
    pub from_account: bool,
    /// Veio de reserva (fallback do banco / foto do índice).
    pub from_fallback: bool,
    /// Mentira comprovada de áudio (`DubLieError`).
    pub lied: bool,
    /// Pack multiobra ADMITIDO (opt-in TMDB) — refeito a cada build.
    pub multi_work_admitted: bool,
    /// Campos públicos preservados que o build não lê.
    pub extra: Map<String, Value>,
}

impl RawItem {
    /// `item.title || item.Title || ''`.
    pub fn title_text(&self) -> &str {
        self.title
            .as_deref()
            .filter(|t| !t.is_empty())
            .or_else(|| self.title_pascal.as_deref().filter(|t| !t.is_empty()))
            .unwrap_or("")
    }

    /// `String(extractInfoHash(r.infoHash || r.magnet || '') || '').toLowerCase()`.
    pub fn hash(&self) -> String {
        let raw = self
            .info_hash
            .as_deref()
            .filter(|h| !h.is_empty())
            .or(self.magnet.as_deref());
        extract_info_hash(raw.unwrap_or("")).unwrap_or_default()
    }

    /// `magnetDisplayName(r)`: o `dn=` do primeiro campo preenchido.
    pub fn dn(&self) -> String {
        magnet_display_name(
            self.magnet.as_deref(),
            self.magnet_uri.as_deref(),
            self.guid.as_deref(),
        )
    }

    pub fn to_relevance(&self) -> adom_core::RelevanceItem {
        adom_core::RelevanceItem {
            title: self.title.clone(),
            title_pascal: self.title_pascal.clone(),
            magnet: self.magnet.clone(),
            magnet_uri: self.magnet_uri.clone(),
            guid: self.guid.clone(),
            is_br: self.is_br,
        }
    }

    pub fn to_episode_filter(&self) -> adom_core::EpisodeFilterItem<'_> {
        adom_core::EpisodeFilterItem {
            title: self.title.as_deref(),
            title_pascal: self.title_pascal.as_deref(),
            magnet: self.magnet.as_deref(),
            magnet_uri: self.magnet_uri.as_deref(),
            guid: self.guid.as_deref(),
            info_hash: self.info_hash.as_deref(),
            from_account: self.from_account,
            is_br: self.is_br,
        }
    }
}

/// `Value` de um campo extra quando é string não vazia.
pub fn extra_str<'a>(item: &'a RawItem, key: &str) -> Option<&'a str> {
    item.extra
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titulo_cai_no_title_e_depois_no_title_pascal() {
        let mut item = RawItem::default();
        assert_eq!(item.title_text(), "");
        item.title_pascal = Some("Pascal".into());
        assert_eq!(item.title_text(), "Pascal");
        item.title = Some("normal".into());
        assert_eq!(item.title_text(), "normal");
    }

    #[test]
    fn hash_vem_do_info_hash_ou_do_magnet_minusculo() {
        let mut item = RawItem::default();
        assert_eq!(item.hash(), "");
        item.magnet =
            Some("magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=x".into());
        assert_eq!(item.hash(), "abcdef0123456789abcdef0123456789abcdef01");
        item.info_hash = Some("0123456789ABCDEF0123456789ABCDEF01234567".into());
        assert_eq!(item.hash(), "0123456789abcdef0123456789abcdef01234567");
    }
}
