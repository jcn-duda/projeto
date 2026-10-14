//! Upsert idempotente (`decideUpsert`) e marcação de resultado (`applyResult`):
//! as duas decisões puras que as engines SQLite e memória compartilham. A linha
//! é reconstruída em campos tipados para sair NA ORDEM CANÔNICA do
//! `JSON.stringify` (a comparação de golden é textual).

use serde_json::{Map, Value};

use crate::js_text::{js_number, js_to_string};

use super::codec::{imdb_opt, kind_of, num_field, parse_status};
use super::{error_backoff_ms, num, truthy_string, CRAWL_GIVE_UP_MS, DEFAULT_RETRY_BASE_MS};

/// Linha de `crawl_url` em memória.
pub(super) struct Row {
    site: String,
    url: String,
    lastmod: String,
    kind: String,
    status: String,
    imdb: Option<String>,
    tries: f64,
    next_at: f64,
    checked_at: f64,
    releases: f64,
    error: String,
    progress: String,
    added_at: f64,
}

impl Row {
    /// Linha vinda de um objeto com chaves camelCase (o `existing` de
    /// `decideUpsert`/`applyResult`). O `status` é usado CRU — o fonte não
    /// revalida o estado de uma linha existente.
    fn from_existing(v: &Value) -> Row {
        Row {
            site: truthy_string(v.get("site")),
            url: truthy_string(v.get("url")),
            lastmod: truthy_string(v.get("lastmod")),
            kind: kind_of(v),
            status: v
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending")
                .to_string(),
            imdb: imdb_opt(v.get("imdb")),
            tries: num_field(v, "tries"),
            next_at: num_field(v, "nextAt"),
            checked_at: num_field(v, "checkedAt"),
            releases: num_field(v, "releases"),
            error: truthy_string(v.get("error")),
            progress: truthy_string(v.get("progress")),
            added_at: num_field(v, "addedAt"),
        }
    }

    /// Linha vinda de uma linha CRUA do banco (chaves snake_case), com o
    /// `status` passando por `parseStatus` (legado/ilegível → `pending`).
    pub(super) fn from_snake(v: &Value) -> Row {
        Row {
            site: truthy_string(v.get("site")),
            url: truthy_string(v.get("url")),
            lastmod: truthy_string(v.get("lastmod")),
            kind: kind_of(v),
            status: parse_status(v.get("status").unwrap_or(&Value::Null)),
            imdb: imdb_opt(v.get("imdb")),
            tries: num_field(v, "tries"),
            next_at: num_field(v, "next_at"),
            checked_at: num_field(v, "checked_at"),
            releases: num_field(v, "releases"),
            error: truthy_string(v.get("error")),
            progress: truthy_string(v.get("progress")),
            added_at: num_field(v, "added_at"),
        }
    }

    /// Ordem canônica das chaves da linha (upsert/render/parse).
    pub(super) fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("site".to_string(), Value::String(self.site.clone()));
        m.insert("url".to_string(), Value::String(self.url.clone()));
        m.insert("lastmod".to_string(), Value::String(self.lastmod.clone()));
        m.insert("kind".to_string(), Value::String(self.kind.clone()));
        m.insert("status".to_string(), Value::String(self.status.clone()));
        m.insert(
            "imdb".to_string(),
            self.imdb.clone().map(Value::String).unwrap_or(Value::Null),
        );
        m.insert("tries".to_string(), num(self.tries));
        m.insert("nextAt".to_string(), num(self.next_at));
        m.insert("checkedAt".to_string(), num(self.checked_at));
        m.insert("releases".to_string(), num(self.releases));
        m.insert("error".to_string(), Value::String(self.error.clone()));
        m.insert("progress".to_string(), Value::String(self.progress.clone()));
        m.insert("addedAt".to_string(), num(self.added_at));
        Value::Object(m)
    }
}

/// `decideUpsert(site, existing, entry, now)` — decisão pura do upsert.
/// Devolve `{outcome, row}` (`outcome` antes de `row`, como no fonte).
pub fn decide_upsert(site: &Value, existing: &Value, entry: &Value, now: &Value) -> Value {
    let url = truthy_string(entry.get("url"));
    let lastmod = truthy_string(entry.get("lastmod"));
    let kind = kind_of(entry);
    let mut out = Map::new();

    if existing.is_null() {
        let row = Row {
            site: js_to_string(site),
            url,
            lastmod,
            kind,
            status: "pending".to_string(),
            imdb: None,
            tries: 0.0,
            next_at: 0.0,
            checked_at: 0.0,
            releases: 0.0,
            error: String::new(),
            progress: String::new(),
            added_at: js_number(now),
        };
        out.insert("outcome".to_string(), Value::String("added".to_string()));
        out.insert("row".to_string(), row.to_value());
        return Value::Object(out);
    }

    let mut row = Row::from_existing(existing);
    if row.lastmod == lastmod {
        // Mesmo lastmod: o estado continua verdadeiro, mas a `url` acompanha o
        // host novo (a identidade é o caminho).
        row.url = url;
        out.insert(
            "outcome".to_string(),
            Value::String("unchanged".to_string()),
        );
        out.insert("row".to_string(), row.to_value());
        return Value::Object(out);
    }

    // lastmod novo: reprocessa do zero. A `url`/`site` antigos são PRESERVADOS
    // (spread); a do entry não entra. `addedAt: now` põe o post atualizado na
    // frente da fila.
    row.lastmod = lastmod;
    row.kind = kind;
    row.status = "pending".to_string();
    row.imdb = None;
    row.tries = 0.0;
    row.next_at = 0.0;
    row.checked_at = 0.0;
    row.releases = 0.0;
    row.error = String::new();
    row.progress = String::new();
    row.added_at = js_number(now);
    out.insert(
        "outcome".to_string(),
        Value::String("refreshed".to_string()),
    );
    out.insert("row".to_string(), row.to_value());
    Value::Object(out)
}

/// Membro de `opts` só quando ele é objeto (`opts: MarkOpts = {}` no fonte).
fn opts_member<'a>(opts: &'a Value, key: &str) -> Option<&'a Value> {
    if opts.is_object() {
        opts.get(key)
    } else {
        None
    }
}

/// `opts.maxTries !== undefined`: declarado mesmo valendo `null` (o JS coage
/// `null` a `0` na comparação). `None` = não declarado.
fn opts_max_tries(opts: &Value) -> Option<f64> {
    opts_member(opts, "maxTries").map(js_number)
}

/// `opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS` (nullish, não falsy).
fn retry_base(opts: &Value) -> Value {
    match opts_member(opts, "retryBaseMs") {
        Some(v) if !v.is_null() => v.clone(),
        _ => num(DEFAULT_RETRY_BASE_MS),
    }
}

/// `String(result.error || fallback)`: falsy (`''`, ausente, `0`) → fallback.
fn error_or(result: &Value, fallback: &str) -> String {
    match result.get("error") {
        Some(x) if super::js_truthy(x) => js_to_string(x),
        _ => fallback.to_string(),
    }
}

/// `result.releases ?? fallback` (nullish: o `0` explícito sobrevive).
fn releases_of(result: &Value, fallback: f64) -> f64 {
    match result.get("releases") {
        Some(x) if !x.is_null() => js_number(x),
        _ => fallback,
    }
}

/// `result.imdb !== undefined ? result.imdb : current` — chave ausente herda;
/// chave presente com `null` ZERA de propósito.
fn imdb_over(result: &Value, current: Option<String>) -> Option<String> {
    match result.get("imdb") {
        Some(x) => imdb_opt(Some(x)),
        None => current,
    }
}

/// `applyResult(existing, result, now, opts)` — marcação pura de UMA linha.
/// URL existente é pressuposta pelo chamador (recusa de desconhecida é lá).
pub fn apply_result(existing: &Value, result: &Value, now: &Value, opts: &Value) -> Value {
    let mut row = Row::from_existing(existing);
    let now_n = js_number(now);
    let status = result.get("status").and_then(Value::as_str);

    if status == Some("error") {
        let tries = row.tries + 1.0;
        let exhausted = opts_max_tries(opts).is_some_and(|m| tries >= m);
        let next_at = now_n
            + if exhausted {
                CRAWL_GIVE_UP_MS
            } else {
                error_backoff_ms(&retry_base(opts), &num(tries))
            };
        row.status = "error".to_string();
        row.tries = tries;
        row.next_at = next_at;
        row.checked_at = now_n;
        row.error = error_or(result, "erro");
        // `progress` é PRESERVADO: o retry retoma dos cards já feitos.
        return row.to_value();
    }

    if status == Some("partial") {
        // Avanço: retry no prazo curto da base, sem a mordida do piso do
        // backoff (o parcial não é falha).
        let base = match opts_member(opts, "retryBaseMs") {
            Some(v) if !v.is_null() => js_number(v),
            _ => DEFAULT_RETRY_BASE_MS,
        };
        row.status = "partial".to_string();
        row.tries = 0.0;
        row.next_at = now_n + base;
        row.checked_at = now_n;
        row.releases = releases_of(result, 0.0);
        row.imdb = imdb_over(result, row.imdb.clone());
        row.error = error_or(result, "");
        if let Some(Value::String(s)) = result.get("progress") {
            row.progress = s.clone();
        }
        return row.to_value();
    }

    // Terminais: sucesso limpa erro e fila. `done` sem contagem preserva a
    // anterior; `no-torrent`/`no-work` provam ausência e zeram. `progress: ''`
    // explícito (não herda progresso de um dry-run que completou).
    let done = status == Some("done");
    row.status = status.unwrap_or("pending").to_string();
    row.imdb = imdb_over(result, row.imdb.clone());
    row.releases = releases_of(result, if done { row.releases } else { 0.0 });
    row.next_at = 0.0;
    row.checked_at = now_n;
    row.error = String::new();
    row.progress = String::new();
    row.to_value()
}
