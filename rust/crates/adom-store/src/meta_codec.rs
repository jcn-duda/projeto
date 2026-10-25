//! Codec do cache.db de metadados: tipo → JSON do Node (encode/decode).
//!
//! O formato fica num só lugar: as cinco chaves de getTitles, o __metaV do
//! Cinemeta e o info:null autoritativo da coleção. O store só grava e lê.

use adom_sources::{
    CacheValue, CinemetaMeta, CollectionInfo, CollectionRead, HomeReleaseRead, MediaType, Titles,
};
use serde_json::{json, Map, Value};

use super::META_SCHEMA;

// ── Codificação (tipo → JSON do Node) ───────────────────────────────────────

pub(super) fn encode(namespace: &str, value: &CacheValue) -> Result<Value, String> {
    match (namespace, value) {
        ("meta", CacheValue::Cinemeta(meta)) => Ok(match meta {
            Some(meta) => encode_cinemeta(meta),
            None => json!({ "miss": true }),
        }),
        ("tmdb", CacheValue::Titles(titles)) => Ok(match titles {
            Some(titles) => encode_titles(titles),
            None => json!({ "miss": true }),
        }),
        ("tmdbc", CacheValue::Collection(read)) => Ok(if !read.ok {
            // Falha: o Node grava `{miss:true}` com TTL curto. `ok:true`
            // SEM coleção é ausência autoritativa e vai como `info:null`.
            json!({ "miss": true })
        } else {
            json!({ "info": read.info.as_ref().map(encode_collection) })
        }),
        ("tmdbh", CacheValue::HomeRelease(read)) => Ok(json!({ "at": read.at })),
        (namespace, _) => Err(format!("valor incompatível com o namespace {namespace}")),
    }
}

fn encode_cinemeta(meta: &CinemetaMeta) -> Value {
    let mut out = Map::new();
    if let Some(name) = &meta.name {
        out.insert("name".into(), json!(name));
    }
    if let Some(year) = &meta.year {
        out.insert("year".into(), json!(year));
    }
    out.insert("type".into(), json!(meta.media_type.as_str()));
    if meta.media_type.is_series() {
        // Série SEMPRE leva `episodes` (mesmo `{}`): o `getMeta` do Node só
        // serve do cache uma série com o campo presente.
        let episodes: Map<String, Value> = meta
            .episodes_by_season
            .iter()
            .map(|(season, count)| (season.to_string(), json!(count)))
            .collect();
        out.insert("episodes".into(), Value::Object(episodes));
    }
    if let Some(released) = &meta.released {
        out.insert("released".into(), json!(released));
    }
    if let Some(first_aired) = &meta.first_aired {
        out.insert("firstAired".into(), json!(first_aired));
    }
    if !meta.episode_aired.is_empty() {
        let aired: Map<String, Value> = meta
            .episode_aired
            .iter()
            .map(|aired| {
                (
                    format!("{}:{}", aired.season, aired.episode),
                    json!(aired.date),
                )
            })
            .collect();
        out.insert("episodeAired".into(), Value::Object(aired));
    }
    out.insert("__metaV".into(), json!(META_SCHEMA));
    Value::Object(out)
}

fn encode_titles(titles: &Titles) -> Value {
    // Exatamente as cinco chaves do `getTitles`: `en` e `br` são o marcador de
    // formato (entrada sem eles é MISS lá e aqui).
    json!({
        "pt": titles.pt,
        "original": titles.original,
        "en": titles.en,
        "br": titles.aliases_br,
        "year": titles.year,
        // Quando o TMDB foi consultado: decide a releitura do "sem tradução".
        "at": titles.fetched_at_ms,
    })
}

fn encode_collection(info: &CollectionInfo) -> Value {
    json!({ "name": info.name, "root": info.root, "years": info.years })
}

// ── Decodificação (JSON do Node → tipo) ─────────────────────────────────────

pub(super) fn decode(namespace: &str, value: &Value) -> Option<CacheValue> {
    match namespace {
        "meta" => decode_cinemeta(value).map(CacheValue::Cinemeta),
        "tmdb" => decode_titles(value).map(CacheValue::Titles),
        "tmdbc" => Some(CacheValue::Collection(CollectionRead {
            info: decode_collection(value),
            ok: true,
        })),
        "tmdbh" => Some(CacheValue::HomeRelease(HomeReleaseRead {
            at: value.get("at").and_then(Value::as_i64),
            ok: true,
        })),
        _ => None,
    }
}

fn is_miss(value: &Value) -> bool {
    value.get("miss").and_then(Value::as_bool).unwrap_or(false)
}

fn decode_cinemeta(value: &Value) -> Option<Option<CinemetaMeta>> {
    if is_miss(value) {
        return Some(None);
    }
    // Formato anterior ao `__metaV` (ou gravado por outra ferramenta): o Node
    // reconsulta UMA vez e regrava; aqui vira MISS pelo mesmo motivo — não
    // servir metadado sem as datas que a guarda de pré-air consome.
    if value.get("__metaV").and_then(Value::as_i64) != Some(META_SCHEMA) {
        return None;
    }
    let media_type = value
        .get("type")
        .and_then(Value::as_str)
        .and_then(MediaType::parse)
        .unwrap_or(MediaType::Movie);
    let episodes_by_season = value
        .get("episodes")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(season, count)| season.parse::<i64>().ok().zip(count.as_i64()))
                .collect()
        })
        .unwrap_or_default();
    let episode_aired = value
        .get("episodeAired")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, date)| {
                    let (season, episode) = key.split_once(':')?;
                    Some(adom_sources::EpisodeAired {
                        season: season.parse().ok()?,
                        episode: episode.parse().ok()?,
                        date: date.as_str().filter(|s| !s.is_empty())?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Some(CinemetaMeta {
        name: nonempty(value.get("name")),
        year: nonempty(value.get("year")),
        media_type,
        episodes_by_season,
        released: nonempty(value.get("released")),
        first_aired: nonempty(value.get("firstAired")),
        episode_aired,
    }))
}

fn decode_titles(value: &Value) -> Option<Option<Titles>> {
    if is_miss(value) {
        return Some(None);
    }
    let object = value.as_object()?;
    // `getTitles` trata entrada sem `en`/`br` (ou com o campo legado `aliases`)
    // como MISS: o canônico inglês e os aliases BR mudam o recall e não podem
    // ficar congelados no TTL longo por um formato velho.
    if !object.contains_key("en") || !object.contains_key("br") || object.contains_key("aliases") {
        return None;
    }
    let aliases_br = object
        .get("br")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|alias| !alias.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(Some(Titles {
        pt: nonempty(object.get("pt")),
        original: nonempty(object.get("original")),
        en: nonempty(object.get("en")),
        aliases_br,
        year: nonempty(object.get("year")),
        // O Node não persiste estes campos; só o cliente em memória os tem.
        original_language: None,
        tmdb_id: None,
        is_series: false,
        fetched_at_ms: object.get("at").and_then(Value::as_i64),
    }))
}

fn decode_collection(value: &Value) -> Option<CollectionInfo> {
    let info = value.get("info")?;
    if info.is_null() {
        return None;
    }
    let name = info
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let root = info
        .get("root")
        .and_then(Value::as_str)
        .filter(|root| !root.is_empty())
        .map(str::to_string)?;
    let years = info
        .get("years")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    Some(CollectionInfo { name, root, years })
}

fn nonempty(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => (!text.is_empty()).then(|| text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}
