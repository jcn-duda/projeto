//! Config POR USUÁRIO que viaja no segmento de URL (`/<base64url>/manifest.json`).
//! Porte das funções PURAS de `src/runtime.ts` (`encode`/`decode`/`normalize`/
//! `sealSegment`). O selo AES da `dk` (porte de `src/utils/secret-box.ts`) vive
//! em `dk_seal`; a semântica de valor do JS (`String()`/`Number()`, `slice`
//! UTF-16, `JSON.stringify`, base64url do `Buffer`) vive em `js_text`.
//!
//! O que fica do lado do TS de propósito: `defaults()` (lê `config.*` do
//! operador), `opts()`/`prefix()`/`capture()`/`run()` (AsyncLocalStorage) e o
//! `log.warn` do `open`. Aqui `defaults` e `resolve_secret` entram por
//! parâmetro — mesma decisão de `matches_br_title`, que recebe `cut_tail`.
//!
//! ## Wiring a cargo do operador (não editei `lib.rs` nem `Cargo.toml`)
//! ```toml
//! aes-gcm = "0.11.1"   # em dk_seal: AES-256-GCM do selo
//! scrypt  = "0.12.0"   # em dk_seal: derivação da chave do RESOLVE_SECRET
//! serde_json = { version = "1", features = ["preserve_order"] } # ja dev-dep
//! ```
//! e `mod config_encoding; mod dk_seal;` no `lib.rs`. `preserve_order` é
//! CONTRATO: `seal_segment` reescreve o objeto cru e o `JSON.stringify` preserva
//! a ordem de inserção — sem isso o install URL selado seria outro byte a byte.
//!
//! ## Divergências conhecidas (assumidas, não escondidas)
//! - O `seal` do Node usa `randomBytes(12)`; aqui o nonce é PARÂMETRO para a
//!   função continuar pura e o golden ser determinístico. A camada que chama
//!   (NAPI/Node) fornece os 12 bytes aleatórios.
//! - `String(x).slice(0, N)` corta em unidades UTF-16 e pode deixar surrogate
//!   órfão; em Rust não existe `String` com surrogate isolado, então o par
//!   incompleto não é aberto ao meio (só toca chave com emoji no limite).
//! - A ordem das chaves do `jl` vem do `localeCompare` (ICU). Para o alfabeto de
//!   `SAFE_INDEXER_ID` (`[a-z0-9_-]`, já minúsculo por construção) a tabela
//!   `ICU_RANK` reproduz o ICU — validada contra o Node em 20.000 pares, zero
//!   divergência. Não é a ordem de bytes (`-` viria antes de `_`).

use serde_json::{Map, Value};

// A superfície do selo continua alcançável por aqui (reexport, não cópia): o
// chamador do contrato de config vê `seal_dk`/`unseal_dk` sem saber de `dk_seal`.
pub use crate::dk_seal::{
    derive_dk_key, is_sealed, seal_dk, unseal_dk, DK_MAX_CHARS, IV_BYTES, SEALED_PREFIX,
};
// O codificador do segmento é parte da superfície deste módulo também.
pub use crate::js_text::{b64url_decode, b64url_encode};
use crate::js_text::{
    clamp_trunc, js_number, js_number_of_str, js_slice_units, js_stringify, js_to_string, js_trim,
};

/// Tetos do segmento e dos valores (constantas do `runtime.ts`).
pub const MAX_CONFIG_SEGMENT: usize = 8192;
pub const STRING_MAX_CHARS: usize = 200;
pub const INTMAP_MAX_ENTRIES: usize = 100;
/// Chave curta do `dk` no JSON da URL (`SCHEMA.debridApiKey.key`).
pub const DK_KEY: &str = "dk";

/// Ordem do ICU root para `[a-z0-9_-]`: `_` < `-` < dígitos < letras.
const ICU_RANK: &[u8; 38] = b"_-0123456789abcdefghijklmnopqrstuvwxyz";

fn icu_rank(c: u8) -> u8 {
    ICU_RANK.iter().position(|&x| x == c).unwrap_or(255) as u8
}

/// `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` do `runtime.ts`.
fn safe_indexer_id(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=64).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b[1..]
            .iter()
            .all(|&c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// Tipos do `SCHEMA`: `(nome da opção, chave curta da URL, tipo)`. A ordem do
/// array é a ordem de iteração do `Object.entries` do TS.
enum Spec {
    List,
    Int(i64, i64),
    IntMap(i64, i64),
    Bool,
    Str,
    Secret,
}
const SCHEMA: &[(&str, &str, Spec)] = &[
    ("providers", "p", Spec::List),
    ("qualities", "q", Spec::List),
    ("maxResults", "m", Spec::Int(1, 100)),
    ("minSeeders", "s", Spec::Int(0, 1000)),
    ("brReservedSlots", "b", Spec::Int(0, 40)),
    ("brFirst", "bf", Spec::Bool),
    ("jackettIndexers", "ji", Spec::List),
    ("indexerPriority", "ip", Spec::List),
    ("indexerLimits", "jl", Spec::IntMap(0, 20)),
    ("brOnly", "o", Spec::Bool),
    ("dubbedOnly", "d", Spec::Bool),
    ("preferDubbed", "a", Spec::Bool),
    ("excludeCam", "c", Spec::Bool),
    ("maxSizeGb", "z", Spec::Int(0, 200)),
    ("max2160p", "q4", Spec::Int(0, 100)),
    ("max1080p", "q1", Spec::Int(0, 100)),
    ("max720p", "q7", Spec::Int(0, 100)),
    ("max480p", "q5", Spec::Int(0, 100)),
    ("maxSd", "qs", Spec::Int(0, 100)),
    ("maxUnknown", "qn", Spec::Int(0, 100)),
    ("maxPerIndexer", "qi", Spec::Int(0, 100)),
    ("debridService", "ds", Spec::Str),
    // Aceita texto puro (install URL antigo) ou selo; pra dentro é sempre claro.
    ("debridApiKey", DK_KEY, Spec::Secret),
    ("debridCachedOnly", "dc", Spec::Bool),
    ("showUncachedBr", "bu", Spec::Bool),
    ("autoFetchBr", "ab", Spec::Bool),
    ("streamNameStyle", "ns", Spec::Str),
    ("streamNameShowSource", "st", Spec::Bool),
];

/// `^[A-Za-z0-9_-]+$` com teto de tamanho — o portão do roteador.
pub fn is_config_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= MAX_CONFIG_SEGMENT
        && segment
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Objeto cru do segmento (antes do overlay). `None` quando não é config — é
/// assim que o roteador distingue `/<config>/manifest.json` de rota comum;
/// array, scalar e JSON malformado caem aqui.
pub fn parse_segment(segment: &str) -> Option<Value> {
    if !is_config_segment(segment) {
        return None;
    }
    let raw = b64url_decode(segment);
    let texto = String::from_utf8_lossy(&raw);
    let parsed: Value = serde_json::from_str(&texto).ok()?;
    matches!(parsed, Value::Object(_)).then_some(parsed)
}

/// `encode` do `runtime.ts`: `JSON.stringify` + base64url.
pub fn encode_config(raw: &Value) -> String {
    b64url_encode(js_stringify(raw).as_bytes())
}

/// `decode` do `runtime.ts`: validação + parse + overlay. `None` quando o
/// segmento não é config — é assim que o roteador o distingue de outra rota.
/// Os defaults só vêm para fora sem segmento via `normalize_overlay(None)`.
pub fn decode_config(segment: &str, defaults: &Value, resolve_secret: &str) -> Option<Value> {
    let raw = parse_segment(segment)?;
    Some(normalize_overlay(Some(&raw), defaults, resolve_secret))
}

/// `normalize` do `runtime.ts`: aplica o overlay do `SCHEMA` sobre os defaults
/// INJETADOS, ignorando qualquer chave desconhecida (o resto é decisão do
/// operador da instância).
pub fn normalize_overlay(raw: Option<&Value>, defaults: &Value, resolve_secret: &str) -> Value {
    let mut base: Map<String, Value> = match defaults {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let Some(Value::Object(raw)) = raw else {
        return Value::Object(base);
    };
    for (name, key, spec) in SCHEMA {
        let Some(value) = raw.get(*key) else { continue };
        if value.is_null() {
            continue; // `undefined`/`null` do TS
        }
        let novo = match spec {
            Spec::List => Value::Array(normalize_list(value)),
            Spec::Int(min, max) => {
                let n = js_number(value);
                match n.is_finite() {
                    true => Value::from(clamp_trunc(n, *min, *max)),
                    // fallback é o default corrente (`base[name]` do TS)
                    false => base.get(*name).cloned().unwrap_or(Value::Null),
                }
            }
            Spec::IntMap(min, max) => Value::Object(normalize_int_map(value, *min, *max)),
            Spec::Bool => Value::Bool(js_truthy(value)),
            Spec::Str => Value::String(js_slice_units(&js_to_string(value), STRING_MAX_CHARS)),
            // O selo é bem mais longo que a chave crua; cortar em 400 unidades
            // UTF-16 antes de abrir é o teto do TS.
            Spec::Secret => Value::String(unseal_dk(
                &js_slice_units(&js_to_string(value), DK_MAX_CHARS),
                resolve_secret,
            )),
        };
        base.insert((*name).to_string(), novo);
    }
    Value::Object(base)
}

/// `value === true || value === 1 || value === '1' || value === 'true'` — as
/// quatro comparações ESTRITAS, sem coerção (um array `[1]` não é verdade).
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::Number(n) => js_number_of_str(&n.to_string()) == 1.0,
        Value::String(s) => s == "1" || s == "true",
        _ => false,
    }
}

/// Lista: `,` e `+` são separadores, `trim` do JS, minúsculas, sem vazios.
fn normalize_list(value: &Value) -> Vec<Value> {
    let itens: Vec<String> = match value {
        Value::Array(list) => list.iter().map(js_to_string).collect(),
        other => vec![js_to_string(other)],
    };
    itens
        .iter()
        .flat_map(|item| item.split([',', '+']))
        .map(|s| js_trim(s).to_lowercase())
        .filter(|s| !s.is_empty())
        .map(Value::String)
        .collect()
}

/// Mapa compacto `id:limite,id:limite`; 0 é override explícito sem limite.
/// O `split(':', 2)` do JS DESCARTA o resto (`"a:1:2"` → `["a","1"]`), por isso
/// dois `next()` e não `splitn(2)`, que deixaria `"1:2"`.
fn normalize_int_map(value: &Value, min: i64, max: i64) -> Map<String, Value> {
    let pares: Vec<(String, Option<String>)> = match value {
        Value::Array(list) => list.iter().map(|v| split_pair(&js_to_string(v))).collect(),
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| (k.clone(), Some(js_to_string(v))))
            .collect(),
        other => {
            let texto = js_to_string(other);
            texto.split(',').map(split_pair).collect()
        }
    };
    let mut limites: Map<String, Value> = Map::new();
    for (id, limite) in pares.into_iter().take(INTMAP_MAX_ENTRIES) {
        // Sem `:` ou limite vazio: não é override (`''` passa, `null` não vem).
        let Some(limite) = limite.filter(|l| !l.is_empty()) else {
            continue;
        };
        let id = js_trim(&id).to_lowercase();
        if !safe_indexer_id(&id) {
            continue;
        }
        let n = js_number_of_str(&limite);
        if n.is_finite() {
            limites.insert(id, Value::from(clamp_trunc(n, min, max))); // último ganha
        }
    }
    let mut chaves: Vec<&String> = limites.keys().collect();
    chaves.sort_by(|a, b| {
        let (ab, bb) = (a.as_bytes(), b.as_bytes());
        let primeiro_diferente = (0..ab.len().min(bb.len()))
            .map(|i| (icu_rank(ab[i]), icu_rank(bb[i])))
            .find(|(x, y)| x != y);
        // ICU: desempate por tamanho quando uma é prefixo da outra.
        primeiro_diferente.map_or(ab.len().cmp(&bb.len()), |(x, y)| x.cmp(&y))
    });
    chaves
        .into_iter()
        .map(|k| (k.clone(), limites[k].clone()))
        .collect()
}

fn split_pair(s: &str) -> (String, Option<String>) {
    let mut partes = s.split(':');
    (
        partes.next().unwrap_or_default().to_string(),
        partes.next().map(str::to_string),
    )
}

/// Truthiness JS de `!parsed[dk]`: `false`, `0`, `""` e `null` significam "sem
/// chave" (P2P puro); `"0"`, `[]` e `{}` são valores verdadeiros.
fn tem_chave(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => js_number_of_str(&n.to_string()) != 0.0,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `sealSegment` do `runtime.ts`: devolve o mesmo segmento com a chave de
/// debrid selada, ou `None` se não for config. Reescreve o objeto CRU, sem
/// normalizar — o que o usuário escolheu tem que voltar exatamente igual, só
/// com o `dk` trocado. Sem chave (P2P puro) ou já selada, devolve como veio.
pub fn seal_segment(segment: &str, resolve_secret: &str, nonce: &[u8; IV_BYTES]) -> Option<String> {
    let parsed = parse_segment(segment)?;
    let Value::Object(mut map) = parsed else {
        return None;
    };
    let Some(atual) = map.get(DK_KEY) else {
        return Some(segment.to_string());
    };
    // `!parsed[dk] || isSealed(parsed[dk])` => devolve o segmento cru.
    if !tem_chave(atual) || is_sealed(&js_to_string(atual)) {
        return Some(segment.to_string());
    }
    let texto = js_slice_units(&js_to_string(atual), STRING_MAX_CHARS);
    let selado = seal_dk(&texto, resolve_secret, nonce);
    map.insert(DK_KEY.to_string(), Value::String(selado));
    Some(encode_config(&Value::Object(map)))
}
