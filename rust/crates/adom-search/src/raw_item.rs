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
    /// Veio de reserva (fallback do banco): entra no 📦 e no `fallbackBlocked`.
    pub from_fallback: bool,
    /// Foto do índice (`fromSnapshot`): exibe 📦 até a promoção tardia, mas NÃO
    /// é reserva bloqueada (no TS, `_fromSnapshot` não entra no `fallbackBlocked`).
    pub from_snapshot: bool,
    /// Mentira comprovada de áudio (`DubLieError`).
    pub lied: bool,
    /// Prova de ARQUIVO (`applyFileEvidence` do Node, vinda do índice):
    /// `Some("")` é prova de release EN, não ausência de prova.
    pub proven_audio: Option<String>,
    pub proven_name: Option<String>,
    pub proven_quality: Option<String>,
    /// Origem BR só pelo indexer, sem promessa de áudio (`brOriginOnly`).
    pub br_origin_only: bool,
    /// DUAL global cujo título começa com o nome pt do TMDB (`ptTitleDual`,
    /// marcado pelo Node): prova de origem BR que o acento não trouxe.
    pub pt_title_dual: bool,
    /// Rótulo do tracker para exibição (`tracker || Tracker || Indexer` do
    /// Jackett, ex.: "Rede Torrent"); `indexer` segue sendo o id das cotas.
    pub tracker: Option<String>,
    /// Fonte gravada no índice (`mediaSource`) para raw sem magnet.
    pub media_source: Option<String>,
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

/// `Value` opaco do collect → [`RawItem`] (campos que o build lê).
pub fn raw_item_from_value(v: &Value) -> RawItem {
    let str_of = |keys: &[&str]| {
        keys.iter().find_map(|k| {
            v.get(*k)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
    };
    let f64_of = |keys: &[&str]| {
        keys.iter().find_map(|k| {
            v.get(*k).and_then(|x| match x {
                Value::Number(n) => n.as_f64(),
                Value::String(s) => s.parse().ok(),
                _ => None,
            })
        })
    };
    let bool_of = |key: &str| v.get(key).and_then(Value::as_bool).unwrap_or(false);
    let sources = v
        .get("sources")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    RawItem {
        title: str_of(&["title"]),
        title_pascal: str_of(&["Title"]),
        magnet: str_of(&["magnet"]),
        magnet_uri: str_of(&["magnetUri", "magnet_uri"]),
        guid: str_of(&["guid"]),
        info_hash: str_of(&["infoHash", "info_hash"]),
        published_at: f64_of(&["publishedAt", "PublishDate", "published_at"]),
        seeders: f64_of(&["seeders"]),
        size_bytes: f64_of(&["sizeBytes", "size", "size_bytes"]),
        indexer: str_of(&["indexer"]),
        sources,
        is_br: bool_of("isBr") || bool_of("is_br"),
        from_account: bool_of("fromAccount") || bool_of("from_account"),
        from_fallback: bool_of("fromFallback") || bool_of("from_fallback"),
        from_snapshot: bool_of("fromSnapshot") || bool_of("from_snapshot"),
        lied: bool_of("lied"),
        proven_audio: v
            .get("provenAudio")
            .and_then(Value::as_str)
            .map(str::to_string),
        proven_name: str_of(&["provenName"]),
        proven_quality: str_of(&["provenQuality"]),
        br_origin_only: bool_of("brOriginOnly"),
        pt_title_dual: bool_of("ptTitleDual"),
        tracker: str_of(&["tracker", "Tracker", "Indexer"]),
        media_source: str_of(&["mediaSource"]),
        multi_work_admitted: false,
        extra: Map::new(),
    }
}

// ── Fio (rotas internas do Node) ───────────────────────────────────────────

impl RawItem {
    /// De volta ao fio, para o `index-write`: os campos originais (preservados
    /// em `extra`) com os normalizados por cima. Nada de campo interno novo —
    /// o Node grava o índice com o que a fonte publicou.
    pub fn to_wire(&self) -> Value {
        let mut map = self.extra.clone();
        let mut put = |key: &str, value: Value| {
            map.insert(key.to_string(), value);
        };
        if let Some(title) = &self.title {
            put("title", Value::String(title.clone()));
        }
        if let Some(title) = &self.title_pascal {
            put("Title", Value::String(title.clone()));
        }
        if let Some(magnet) = &self.magnet {
            put("magnet", Value::String(magnet.clone()));
        }
        if let Some(uri) = &self.magnet_uri {
            put("MagnetUri", Value::String(uri.clone()));
        }
        if let Some(guid) = &self.guid {
            put("Guid", Value::String(guid.clone()));
        }
        if let Some(hash) = &self.info_hash {
            put("infoHash", Value::String(hash.clone()));
        }
        if let Some(seeders) = self.seeders.and_then(serde_json::Number::from_f64) {
            put("seeders", Value::Number(seeders));
        }
        if let Some(size) = self.size_bytes.and_then(serde_json::Number::from_f64) {
            put("size", Value::Number(size));
        }
        if let Some(indexer) = &self.indexer {
            put("indexer", Value::String(indexer.clone()));
        }
        if !self.sources.is_empty() {
            put(
                "sources",
                Value::Array(
                    self.sources
                        .iter()
                        .map(|s| Value::String(s.clone()))
                        .collect(),
                ),
            );
        }
        if self.is_br {
            put("isBr", Value::Bool(true));
        }
        if self.from_account {
            put("fromAccount", Value::Bool(true));
        }
        if self.from_fallback {
            put("fromFallback", Value::Bool(true));
        }
        if self.from_snapshot {
            put("fromSnapshot", Value::Bool(true));
        }
        if self.lied {
            put("lied", Value::Bool(true));
        }
        if let Some(published) = self.published_at.and_then(serde_json::Number::from_f64) {
            put("publishedAt", Value::Number(published));
        }
        Value::Object(map)
    }
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
