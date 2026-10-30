//! Registros do arquivo de import (`readMagnet`/`readSource`/`readWork` do TS,
//! `src/utils/magnet-bank-transfer.ts`) e as regras de mescla linha × linha
//! (`mergeMagnetRows`/`mergeSourceRows`/`mergeWorkRows`).
//!
//! O arquivo é entrada de fora (um export antigo, ou editado à mão): o banco não
//! pode receber hash que não é hash nem URI que não é magnet. Campo fora da
//! régua vira o DEFAULT dele (texto vazio, zero), não erro — um número estranho
//! não deve jogar fora um magnet válido. Só o que não tem identidade (hash,
//! indexer, imdb) é recusado.
//!
//! As datas vêm do arquivo, nunca do relógio: a mescla é a do próprio banco
//! (`first_seen` o mais antigo, `last_seen` o mais novo, flags só sobem).

use serde_json::Value;

use super::super::capture::is_richer_uri;

/// `MAX_URI` do TS: magnet acima disso é descartado (vira a URI padrão).
const MAX_URI: usize = 2048;

/// Linha de `magnet` do arquivo, já validada e no formato do banco.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct BankMagnet {
    pub hash: String,
    pub uri: String,
    pub title: String,
    pub size: i64,
    pub is_br: i64,
    pub dubbed: i64,
    pub quality: String,
    pub seeders_max: i64,
    pub seeders_last: i64,
    pub first_seen: i64,
    pub last_seen: i64,
    pub lied: i64,
}

/// Linha de `magnet_source` do arquivo.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct BankSource {
    pub hash: String,
    pub indexer: String,
    pub tracker: String,
    pub first_seen: i64,
    pub last_seen: i64,
    pub seeders_last: i64,
}

/// Linha de `magnet_work` do arquivo. `season`/`episode` = -1 quando nulos.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct BankWork {
    pub hash: String,
    pub imdb: String,
    pub season: i64,
    pub episode: i64,
    pub first_seen: i64,
    pub last_seen: i64,
    pub passed_filter: i64,
}

/// Chave da PK de `magnet_work` (hash, imdb, season, episode).
pub(super) type WorkKey = (String, String, i64, i64);

pub(super) fn work_key(row: &BankWork) -> WorkKey {
    (row.hash.clone(), row.imdb.clone(), row.season, row.episode)
}

// --- Conversões no estilo do JS (o arquivo foi escrito pelo TS) -------------

/// `Number(v)` do JS: número, texto, booleano, `null` ou ausente. `NaN` quando
/// não vira número — o chamador decide o default de cada campo.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                // `inf`/`NaN` do Rust não são números no JS; descartá-los aqui
                // mantém `int` e `flag` com o mesmo veredito do TS.
                trimmed
                    .parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite())
                    .unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// `int(v, min)` do TS: trunca; não finito ou abaixo do mínimo vira o mínimo.
fn int_field(value: Option<&Value>, min: i64) -> i64 {
    let n = js_number(value).trunc();
    if n.is_finite() && n >= min as f64 {
        n as i64
    } else {
        min
    }
}

/// `flag(v)` do TS: qualquer número diferente de zero (e não NaN) é 1.
fn flag_field(value: Option<&Value>) -> i64 {
    let n = js_number(value);
    i64::from(!n.is_nan() && n != 0.0)
}

/// `str(v, max)` do TS: só texto conta; o resto vira vazio. O corte é por
/// caractere, e não por unidade UTF-16 como no `slice` do JS — a diferença só
/// aparece com emoji exatamente no limite, e não muda nenhuma regra.
fn text_field(value: Option<&Value>, max: usize) -> String {
    match value {
        Some(Value::String(text)) => text.chars().take(max).collect(),
        _ => String::new(),
    }
}

/// Texto no estilo `String(v)` do JS, só para a mensagem de versão recusada.
pub(super) fn js_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number
            .as_f64()
            .map_or_else(|| number.to_string(), |n| n.to_string()),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_text(Some(item))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

// --- Validação de cada campo-chave -----------------------------------------

/// `HASH_RE` do TS: 40 hex minúsculos (SHA-1) ou 32 base32 (`a-z2-7`).
fn is_info_hash(text: &str) -> bool {
    let bytes = text.as_bytes();
    match bytes.len() {
        40 => bytes
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)),
        32 => bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(b)),
        _ => false,
    }
}

/// Hash do registro: corta em 64, põe em minúsculo e confere a régua.
fn hash_field(value: Option<&Value>) -> Option<String> {
    let lower = text_field(value, 64).to_lowercase();
    is_info_hash(&lower).then_some(lower)
}

/// `^tt\d{1,12}$`.
fn is_imdb(text: &str) -> bool {
    text.strip_prefix("tt").is_some_and(|digits| {
        (1..=12).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
    })
}

/// URI só entra quando é magnet e cabe em 2048 unidades UTF-16 (a régua do TS).
/// Fora disso fica vazia: o play cai no magnet padrão do hash, que é o que um
/// banco sem URI já faz. Recusar o registro inteiro perderia o hash à toa.
fn uri_field(value: Option<&Value>) -> String {
    let raw = match value {
        Some(Value::String(text)) => text.as_str(),
        _ => "",
    };
    let is_magnet = raw
        .get(..8)
        .is_some_and(|head| head.eq_ignore_ascii_case("magnet:?"));
    if is_magnet && raw.encode_utf16().count() <= MAX_URI {
        raw.to_string()
    } else {
        String::new()
    }
}

// --- Leitura dos registros --------------------------------------------------

/// `readMagnet`: `None` quando o hash não é válido.
pub(super) fn read_magnet(o: &Value) -> Option<BankMagnet> {
    Some(BankMagnet {
        hash: hash_field(o.get("hash"))?,
        uri: uri_field(o.get("uri")),
        title: text_field(o.get("title"), 500),
        size: int_field(o.get("size"), 0),
        is_br: flag_field(o.get("isBr")),
        dubbed: flag_field(o.get("dubbed")),
        quality: text_field(o.get("quality"), 20),
        seeders_max: int_field(o.get("seedersMax"), 0),
        seeders_last: int_field(o.get("seedersLast"), 0),
        first_seen: int_field(o.get("firstSeen"), 0),
        last_seen: int_field(o.get("lastSeen"), 0),
        lied: flag_field(o.get("lied")),
    })
}

/// `readSource`: exige hash e indexer (o indexer é parte da chave).
pub(super) fn read_source(o: &Value) -> Option<BankSource> {
    let hash = hash_field(o.get("hash"))?;
    let indexer = text_field(o.get("indexer"), 100);
    if indexer.is_empty() {
        return None;
    }
    Some(BankSource {
        hash,
        indexer,
        tracker: text_field(o.get("tracker"), 100),
        first_seen: int_field(o.get("firstSeen"), 0),
        last_seen: int_field(o.get("lastSeen"), 0),
        seeders_last: int_field(o.get("seedersLast"), 0),
    })
}

/// `readWork`: exige hash e imdb válido. Temporada/episódio ausentes viram -1,
/// como a PK do banco exige.
pub(super) fn read_work(o: &Value) -> Option<BankWork> {
    let hash = hash_field(o.get("hash"))?;
    let imdb = text_field(o.get("imdb"), 20);
    if !is_imdb(&imdb) {
        return None;
    }
    Some(BankWork {
        hash,
        imdb,
        season: int_field(o.get("season"), -1),
        episode: int_field(o.get("episode"), -1),
        first_seen: int_field(o.get("firstSeen"), 0),
        last_seen: int_field(o.get("lastSeen"), 0),
        passed_filter: flag_field(o.get("passedFilter")),
    })
}

// --- Mesclagem (as regras do banco vivo) ------------------------------------

/// `minSeen` do TS: o menor carimbo não zero (zero = "não sabemos").
fn min_seen(a: i64, b: i64) -> i64 {
    if a != 0 && b != 0 {
        a.min(b)
    } else if a != 0 {
        a
    } else {
        b
    }
}

/// `mergeMagnetRows`. O título NÃO troca aqui (ao contrário da captura, que faz
/// o `episodeUpgrade`): o import preserva o que já está no banco.
pub(super) fn merge_magnet(prev: Option<BankMagnet>, next: BankMagnet) -> BankMagnet {
    let Some(prev) = prev else {
        return next;
    };
    let newer = next.last_seen > prev.last_seen;
    BankMagnet {
        hash: prev.hash,
        uri: if is_richer_uri(&next.uri, &prev.uri) {
            next.uri
        } else {
            prev.uri
        },
        title: if prev.title.is_empty() {
            next.title
        } else {
            prev.title
        },
        size: if prev.size != 0 { prev.size } else { next.size },
        is_br: prev.is_br.max(next.is_br),
        dubbed: prev.dubbed.max(next.dubbed),
        quality: if prev.quality.is_empty() {
            next.quality
        } else {
            prev.quality
        },
        seeders_max: prev.seeders_max.max(next.seeders_max),
        seeders_last: if newer {
            next.seeders_last
        } else {
            prev.seeders_last
        },
        first_seen: min_seen(prev.first_seen, next.first_seen),
        last_seen: prev.last_seen.max(next.last_seen),
        lied: prev.lied.max(next.lied),
    }
}

/// `mergeSourceRows`.
pub(super) fn merge_source(prev: Option<BankSource>, next: &BankSource) -> BankSource {
    let Some(prev) = prev else {
        return next.clone();
    };
    let newer = next.last_seen > prev.last_seen;
    BankSource {
        hash: prev.hash,
        indexer: prev.indexer,
        tracker: if prev.tracker.is_empty() {
            next.tracker.clone()
        } else {
            prev.tracker
        },
        first_seen: min_seen(prev.first_seen, next.first_seen),
        last_seen: prev.last_seen.max(next.last_seen),
        seeders_last: if newer {
            next.seeders_last
        } else {
            prev.seeders_last
        },
    }
}

/// `mergeWorkRows`. `passed_filter` é a ÚLTIMA observação da obra (não é OR):
/// vence o lado com `last_seen` mais novo, e o empate preserva o local.
pub(super) fn merge_work(prev: Option<BankWork>, next: &BankWork) -> BankWork {
    let Some(prev) = prev else {
        return next.clone();
    };
    let newer = next.last_seen > prev.last_seen;
    BankWork {
        first_seen: min_seen(prev.first_seen, next.first_seen),
        last_seen: prev.last_seen.max(next.last_seen),
        passed_filter: if newer {
            next.passed_filter
        } else {
            prev.passed_filter
        },
        ..prev
    }
}
