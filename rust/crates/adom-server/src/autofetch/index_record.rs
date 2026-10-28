//! Registro do ACEITE e do ESQUECIMENTO do Chupim no índice (`idx:v14`) —
//! escritor NATIVO do `source:'autofetch'`.
//!
//! # Por que este módulo existe
//!
//! A Leva B4 cortou `recordAutofetchRelease` (`src/providers/autofetch-index.ts`
//! de HEAD) junto com o runner TS e nenhum escritor nativo o substituiu: o
//! `ReleaseIndexStore::record` aceita `source:'autofetch'` desde sempre
//! (`adom-index/src/release_index_record.rs:234-272`), mas sem CHAMADOR o valor
//! nunca entrava no índice. Os LEITORES ficaram — e ficaram inertes:
//!
//! - `orchestrator/native_index.rs:139-148` — registro do Chupim passa o filtro
//!   de indexador (`allowed_source_indexer`), então ele aparece na resposta;
//! - `orchestrator/native_index.rs:162-166` — `autofetch_seeded` liga a via
//!   rápida do índice SEM esperar a coleta ao vivo;
//! - `orchestrator/index_effects.rs:109-118` — `gap` no follow-up: a coleta
//!   continua no tail (visibilidade, não cobertura);
//! - `adom-index/src/release_index_prova_works.rs:82-110` — `forget_autofetch_hash`
//!   só sabia apagar o que ninguém gravava.
//!
//! # Dois efeitos, um canal
//!
//! O canal do escritor carrega `Op::Keep` (aceite → `record`) **e**
//! `Op::Forget` (hash que morreu/saiu do lote → `forget_autofetch_hash`). Sem o
//! `Forget`, a release morta continuava no índice como `autofetch_seeded` por
//! até 30 dias e ligava a via rápida da busca para um hash que não existe mais.
//! O TS apagava nos dois fim-de-vida do hash:
//!
//! - fim do lote, todos os hashes de saída (`autofetch-recheck.ts:375`);
//! - colapso terminal, morto/parado (`autofetch-terminal.ts:95`).
//!
//! Um canal só porque o SQLite tem UMA conexão por escritor (`index_record_ops`
//! explica: `Mutex<Connection>` no `cache.db` do Node, e o aceite e o
//! esquecimento do MESMO hash podem chegar intercalados).
//!
//! # O que este registro NÃO é
//!
//! Não é prova BR. `has_br_dubbed`/`has_br_evidence`
//! (`adom-core/src/br_gap.rs:28-30,88-92`) e `idx_pool_covered`
//! (`adom-core/src/search_pool_coverage.rs:283-287`) excluem
//! `source == 'autofetch'` de propósito: o aceite prova que ESCOLHEMOS uma
//! release, não que o índice tem material. A release entra visível e o pool
//! continua descoberto.
//!
//! # Fora do caminho da resposta
//!
//! O lote chega pelo canal do laço (`worker.rs:268-279`: `try_send`, sem disco)
//! e o aceite roda na thread do worker. A gravação em si vai para um escritor
//! PRÓPRIO ([`spawn`]): canal com teto + thread dona do SQLite, `try_send`
//! nunca bloqueia. Índice é cache: aceite perdido por restart
//! é perdido como no Node, e o hash continua no marker/`obra`/fila.

use adom_autofetch::v3::CascadeAttempt;
use adom_core::{stream_title_bytes, WorkTarget};
use adom_index::{RecordOptions, ReleaseIndexStore};
use serde_json::{json, Map, Value};

use super::enqueue::Report;
use super::enqueue_items::Item;

/// Escritor (canal + thread): arquivo próprio pela catraca de linhas.
#[path = "index_record_ops.rs"]
mod ops;

// A porta mora em `ops`; os chamadores do ciclo (`boot`, `enqueue`) e os testes
// continuam vendo tudo por aqui.
pub(crate) use self::ops::spawn;
#[cfg(test)]
pub(super) use self::ops::{clear, test_lock};
pub(super) use self::ops::{register, sink, Op, Refuse};

/// `source` da linha: registro do Chupim, não observação pública.
pub(super) const SOURCE: &str = "autofetch";

/// Teto do título gravado: `first_line` do TS não tinha limite, e um título de
/// release enorme iria inteiro para o valor `idx:v14:…`.
const TITLE_LIMIT: usize = 512;

/// Temporada/episódio plausíveis. `WorkTarget` com valor absurdo muda a CHAVE
/// do índice (`…:S<n>E<m>`) e a release vira lixo ilegível para a busca.
const LOCATION_MAX: i64 = 9999;

/// Fatos do aceite que viram release no índice (o `candidate` do TS).
#[derive(Clone, Debug)]
pub(super) struct Accepted {
    pub(super) imdb_id: String,
    pub(super) info_hash: String,
    pub(super) title: String,
    pub(super) size: Option<i64>,
    pub(super) indexer: String,
    pub(super) is_br: bool,
    pub(super) dubbed: bool,
    pub(super) lied: bool,
    pub(super) quality: Option<String>,
    pub(super) seeders: Option<i64>,
    pub(super) season: Option<i64>,
    pub(super) episode: Option<i64>,
}

/// Traduz o aceite para o registro, com os MESMOS fatos que o TS passava:
/// título da 1ª linha, `_size`/`_packBytes`/tamanho do título, `_indexer`/
/// `_tracker`/`autofetch`, `_br`/`_dubbed`/`_lied`, `quality` da cascata (já
/// classificada) e seeders.
///
/// `None` quando não há CHAVE de obra: sem IMDb ou com IMDb fora de `^tt\d+$`
/// (a mesma régua de `forget_autofetch_hash`,
/// `adom-index/src/release_index_prova.rs:66`) o `record` gravaria numa chave
/// que nenhum leitor busca.
pub(super) fn accepted(
    attempt: &CascadeAttempt,
    item: &Item,
    payload: &Map<String, Value>,
) -> Option<Accepted> {
    let imdb_id = payload
        .get("imdbId")
        .and_then(Value::as_str)
        .filter(|id| is_imdb_id(id))?;
    let title = first_line(&item.label());
    let tracker = item.tracker.clone().filter(|text| !text.is_empty());
    let from_title = stream_title_bytes(Some(&title));
    Some(Accepted {
        imdb_id: imdb_id.to_string(),
        info_hash: attempt.info_hash.to_ascii_lowercase(),
        title,
        size: item.size.or(item.pack_bytes).or_else(|| {
            // `streamTitleBytes(title) || undefined`: zero não é tamanho.
            (from_title > 0.0).then_some(from_title as i64)
        }),
        indexer: item
            .indexer
            .clone()
            .filter(|text| !text.is_empty())
            .or_else(|| tracker.clone())
            .unwrap_or_else(|| SOURCE.to_string()),
        is_br: item.br,
        dubbed: item.dubbed,
        lied: item.lied,
        quality: attempt.quality.clone().or_else(|| item.quality.clone()),
        seeders: item.seeders,
        season: location(payload, "season"),
        episode: location(payload, "episode"),
    })
}

/// `/^tt\d+$/` — `tt` + só dígitos, exatamente como `imdb_exato` do
/// `adom-index` (privado daquele crate, então replicado aqui).
fn is_imdb_id(imdb_id: &str) -> bool {
    imdb_id
        .strip_prefix("tt")
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// Temporada/episódio que podem virar chave: `>= 1` e `<= 9999`. Zero, negativo
/// e valor absurdo viram `None` (a chave fica a da raiz), em vez de gravarem
/// `S0`/`S-1` no índice.
fn location(payload: &Map<String, Value>, key: &str) -> Option<i64> {
    payload
        .get(key)
        .and_then(Value::as_i64)
        .filter(|value| (1..=LOCATION_MAX).contains(value))
}

/// `split('\n')[0].trim()` do TS, com teto de [`TITLE_LIMIT`] caracteres.
fn first_line(label: &str) -> String {
    label
        .split('\n')
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(TITLE_LIMIT)
        .collect()
}

/// Grava UMA release do Chupim na chave da obra (`idx:v14:…`).
///
/// A obra/temporada/episódio são as do pedido; o `record` ainda roteia pelo
/// título (pack S2, episódio S02E05), como o TS fazia.
pub(crate) fn record(
    store: &ReleaseIndexStore,
    accepted: &Accepted,
    now_ms: i64,
) -> Result<usize, String> {
    let item = release_item(accepted);
    store.record(
        &accepted.imdb_id,
        WorkTarget {
            season: accepted.season,
            episode: accepted.episode,
        },
        std::slice::from_ref(&item),
        RecordOptions {
            source: Some(SOURCE),
            ..RecordOptions::default()
        },
        store.ttl(),
        store.max_releases(),
        now_ms,
        None,
    )
}

/// Item no formato que o `record` lê. Campo ausente é OMITIDO: `undefined` no
/// TS, e não `null` — `size`/`quality`/`seeders` caem no fallback do título.
fn release_item(accepted: &Accepted) -> Value {
    let mut out = Map::new();
    out.insert("title".into(), json!(accepted.title));
    out.insert("infoHash".into(), json!(accepted.info_hash));
    out.insert("indexer".into(), json!(accepted.indexer));
    out.insert("isBr".into(), json!(accepted.is_br));
    // Presente SEMPRE: no registro do Chupim o `record` confia no `dubbed`
    // classificado e não reinfere pelo título (`release_index_record.rs:262`).
    out.insert("dubbed".into(), json!(accepted.dubbed));
    out.insert("lied".into(), json!(accepted.lied));
    if let Some(size) = accepted.size {
        out.insert("size".into(), json!(size));
    }
    if let Some(quality) = accepted.quality.as_deref() {
        out.insert("quality".into(), json!(quality));
    }
    if let Some(seeders) = accepted.seeders {
        out.insert("seeders".into(), json!(seeders));
    }
    Value::Object(out)
}

/// Chamado no ACEITE confirmado do lote. Conta no painel e nunca falha o lote:
/// índice é cache, o aceite (marker + obra + fila) já é durável.
pub(super) fn keep(
    attempt: &CascadeAttempt,
    item: &Item,
    payload: &Map<String, Value>,
    report: &mut Report,
) {
    let Some(accepted) = accepted(attempt, item, payload) else {
        return;
    };
    // F2 do TS: pool de seeders/`any` não fecha o ciclo BR/dublado — gravá-lo
    // mudaria a primeira resposta da obra por semanas sem benefício.
    if !accepted.is_br && !accepted.dubbed {
        report.skip("index-no-dub");
        return;
    }
    let Some(sink) = sink() else {
        return;
    };
    match sink(Op::Keep(accepted)) {
        Ok(_) => {}
        // Orçamento do escritor cheio é BACKOFF, não falha: o hash continua no
        // marker e o próximo aceite tenta de novo.
        Err(Refuse::Full) => report.skip("index-full"),
        // Escritor fechado/erro de escrita: aí sim o índice ficou sem a linha.
        // Logado, nunca propagado — o aceite (marker + obra + fila) já é durável.
        Err(Refuse::Closed) => {
            eprintln!("[autofetch] registro do aceite no índice falhou (escritor fechado)");
            report.skip("index-error");
        }
    }
}

/// `forgetAutofetchHash` do TS, fora da thread do laço: enfileira o
/// esquecimento no MESMO canal do escritor (`try_send`, sem I/O aqui).
///
/// Fiel ao TS nos dois portões: sem IMDb válido (`^tt\d+$`) ou sem hash é no-op
/// silencioso — `forgetAutofetchHash(undefined, h)` não apagava nada lá também,
/// e a linha do Chupim caduca pelo TTL do índice. Falha de fila **não** falha o
/// lote: índice é cache.
pub(super) fn forget(imdb_id: Option<&str>, hash: &str) {
    let Some(imdb_id) = imdb_id.filter(|id| is_imdb_id(id)) else {
        return;
    };
    let hash = hash.trim().to_ascii_lowercase();
    if hash.is_empty() {
        return;
    }
    let Some(sink) = sink() else {
        return;
    };
    let op = Op::Forget {
        imdb_id: imdb_id.to_string(),
        hash,
    };
    match sink(op) {
        Ok(_) => {}
        // Backoff: a linha sai depois pelo TTL do índice (30 dias é o pior caso,
        // o mesmo de antes deste conserto).
        Err(Refuse::Full) => eprintln!("[autofetch] fila do índice cheia: esquecimento adiado"),
        Err(Refuse::Closed) => {
            eprintln!("[autofetch] escritor do índice fechado: esquecimento perdido")
        }
    }
}

/// Réguas da leitura (`stream_config.rs:95-103`), para o escritor não gravar
/// com TTL/teto diferentes dos que o índice usa.
fn limits() -> Option<(u64, usize)> {
    let enabled = std::env::var("RELEASE_INDEX")
        .map(|raw| raw.trim() == "true")
        .unwrap_or(true);
    let ttl = env_i64("RELEASE_INDEX_TTL")
        .unwrap_or(30 * 24 * 3600)
        .max(0) as u64;
    if !enabled || ttl == 0 {
        return None;
    }
    let max_releases = env_i64("RELEASE_INDEX_MAX_RELEASES").unwrap_or(60).max(1) as usize;
    Some((ttl, max_releases))
}

fn env_i64(key: &str) -> Option<i64> {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
}

#[cfg(test)]
#[path = "index_record_tests.rs"]
mod tests;

// Esquecimento (`forget`/`Op::Forget`) e o esquecimento do fim de lote em
// arquivo próprio: a catraca de 400 linhas de `index_record_tests.rs`.
#[cfg(test)]
#[path = "index_record_forget_tests.rs"]
mod forget_tests;
