//! Evicção F6 FIADA no ciclo: os fallbacks da obra caem depois do ready BR.
//! Porte do TS apagado na B4 (`autofetch-evict.ts` política +
//! `alldebrid-fallback-evict.ts` executor); a régua pura mora em
//! [`super::super::evict_step`] e este módulo LÊ os fatos e executa.
//!
//! # Por que a execução vai pela PORTA, e não por `execute`
//!
//! `evict_step::execute` apaga por `transfer_id` e exige o NOME autoritativo do
//! acervo, mas o trait `AutofetchDebrid` não expõe filename: planejar com âncora
//! aqui daria `NoName` para todo item. A execução vai pela PORTA `evict`
//! (`adom-debrid/src/autofetch_ports_evict.rs`), que re-lê `/magnet/status` e
//! re-prova upload date, `adsub`, `adhold`, `adprot`, `adrm` e a blindagem BR no
//! filename REAL — devolve só o que saiu.
//!
//! # Mapa dos fatos (nada inventado)
//!
//! | Fato | De onde vem |
//! |---|---|
//! | hash ready | snapshot PRÉ-step do lote (`Lot::season_hints`) |
//! | digest da obra | `obra` do marker (`autofetch:v3:m:<adapter>:<conta>:<hash>`) |
//! | `pool`/`overflow`/`acceptedAt` | registro F2 (`autofetch:v3:o:<digest>`) |
//! | `current_ready_is_br` | entrada do PRÓPRIO hash ready: `pool == "br" && dubbed` |
//! | BR ready anterior | chave `autofetch:v3:er:<digest>` viva |
//! | `owned` | `adsub:v1` vivo **e** `adrm:v1` ausente, **e** posse ligada (`ALLDEBRID_SUBMITTED_TTL_MS > 0`) |
//! | `held` / `protected` | `adhold:v1` / `adprot:v1` vivos |
//! | `transfer_id` | marker (`id`), quando o serviço devolveu |
//! | `name` / `br_retained` | a PORTA (filename real) — aqui `None`/`false` |
//!
//! Tudo lê o MESMO `cache.db` que o worker já abriu (`boot::open_kv`).
//!
//! # Fato que o Node ainda é dono, e quem apaga não marca (metade)
//!
//! O marker COM `obra` nasce do Node (ponte napi,
//! `adom-napi/src/autofetch/state_v3.rs`) E do `enqueue` nativo
//! (`obra::marker_meta`), sempre com o digest do registro por obra. Sem eles o
//! passo é fail-closed por construção (`evict-no-marker`/`evict-no-record`),
//! nunca um passe livre. O `adrm` é escrito AQUI (`DEBRID_REUPLOAD_BLOCK` +
//! `ALLDEBRID_REUPLOAD_BLOCK_TTL_MS`).

use std::collections::BTreeMap;

use adom_autofetch::v3::{AutofetchDebrid, ObraStoreV3};
use adom_core::{
    marker_key, marker_obra, marker_transfer_id, obra_prefix, MarkerValue, ObraRecordEntry,
};
use adom_debrid::alldebrid_cleanup::{
    adhold_key, adprot_key, adrm_key, adsub_key, ownership_enabled, reupload_block_enabled,
    REUPLOAD_TTL_ENV,
};
use adom_index::NativeKv;
use serde_json::json;

use super::super::evict_step::{self, EvictFacts, EvictGates, EvictItem};

/// Prefixo da evidência de BR ready — o MESMO de
/// `adom-napi/src/autofetch/state_v3.rs:308` (prefixo `RUST_OWNED`).
const BR_READY_PREFIX: &str = "autofetch:v3:er:";
/// TTL default do `adrm` (`src/debrid/alldebrid-reupload.ts:14`).
const DEFAULT_REUPLOAD_TTL_MS: f64 = 259_200_000.0;

/// O que o lote pronto entregou ao passo. O hash ready NÃO viaja no
/// `StepReport` (`recheck.rs` é dono dele): ele vem do snapshot PRÉ-step.
pub(crate) struct ReadyWork<'a> {
    /// Adapter DONO do lote (nunca o "corrente").
    pub(crate) adapter_id: &'a str,
    /// `accountScope` (sha256 da chave) — o mesmo das chaves `ad*`.
    pub(crate) account: &'a str,
    /// Hashes que ficaram `ready` nesta passagem.
    pub(crate) ready_hashes: &'a [String],
    /// TTL da evidência `er:` (= `autoFetchTtl`, `Policy::lot_ttl_seconds`).
    pub(crate) br_ready_ttl_seconds: i64,
}

/// Réguas do `adrm`. Explícitas nos testes (nenhum teste mexe em env global).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MarkGates {
    pub(crate) enabled: bool,
    pub(crate) ttl_seconds: i64,
}

impl MarkGates {
    pub(crate) fn from_env() -> Self {
        Self {
            enabled: reupload_block_enabled(),
            ttl_seconds: reupload_ttl_seconds(),
        }
    }
}

/// Réguas da passagem: kill-switch/teto da evicção + `adrm` + posse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EvictConfig {
    pub(crate) gates: EvictGates,
    pub(crate) marks: MarkGates,
    /// Posse durável (`adsub`): `ALLDEBRID_SUBMITTED_TTL_MS <= 0` a desliga —
    /// a MESMA régua de `hasDurableOwnership`, no ponto único do passo.
    pub(crate) ownership: bool,
}

impl EvictConfig {
    pub(crate) fn from_env() -> Self {
        Self {
            gates: EvictGates::from_env(),
            marks: MarkGates::from_env(),
            ownership: ownership_enabled(),
        }
    }
}

/// Contadores de UMA passagem de evicção.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct PassReport {
    /// Hashes entregues à porta (pedido de delete).
    pub(crate) requested: usize,
    /// Hashes que a conta confirmou removidos.
    pub(crate) removed: usize,
    /// `adrm` gravados (anti-reenchimento).
    pub(crate) marked: usize,
    /// Motivo → contagem (o mapa de skips do painel).
    pub(crate) skips: BTreeMap<String, usize>,
    pub(crate) errors: Vec<String>,
}

impl PassReport {
    pub(crate) fn skip(&mut self, label: &str) {
        *self.skips.entry(label.to_string()).or_default() += 1;
    }

    /// Absorve o mapa de motivos do plano, prefixado (`evict-<motivo>`).
    fn absorb(&mut self, skips: BTreeMap<&'static str, usize>) {
        for (label, count) in skips {
            *self.skips.entry(format!("evict-{label}")).or_default() += count;
        }
    }
}

/// O passo: hashes ready → plano por obra → porta → `adrm`.
pub(crate) async fn run(
    kv: &NativeKv,
    io: &dyn AutofetchDebrid<Error = String>,
    work: &ReadyWork<'_>,
    config: &EvictConfig,
    now_ms: i64,
) -> PassReport {
    let mut report = PassReport::default();
    // Kill-switch OFF (ou teto 0): zero leitura, zero rede.
    if !config.gates.armed() {
        report.skip("evict-off");
        return report;
    }
    // Posse DESLIGADA (`ALLDEBRID_SUBMITTED_TTL_MS <= 0`): o Node nega a prova
    // (`hasDurableOwnership` → `false`) e a evicção cai junto — sem posse
    // concedida nada é nosso, e um `adsub` que sobrou no KV não vale mais.
    if !config.ownership {
        report.skip("evict-ownership-off");
        return report;
    }
    // Uma obra pode ter VÁRIOS hashes ready na mesma passagem: o plano é por
    // obra, então agrupa pelo digest antes. O teto é da RODADA, não da obra.
    let mut by_work: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for hash in work.ready_hashes {
        match marker_digest(kv, work, hash, now_ms) {
            Ok(Some(digest)) => by_work.entry(digest).or_default().push(hash.clone()),
            // Marker legado/`{id}` (ou ausente) não prova obra: nada a decidir.
            Ok(None) => report.skip("evict-no-marker"),
            Err(err) => report.errors.push(format!("marker de {hash}: {err}")),
        }
    }
    let store = ObraStoreV3::new(kv);
    let mut left = config.gates.max_per_run;
    for (digest, ready_hashes) in by_work {
        if left == 0 {
            report.skip("evict-budget");
            continue;
        }
        let key = format!("{}{digest}", obra_prefix());
        let record = match store.read(&key, now_ms) {
            Ok(record) => record,
            Err(err) => {
                report.errors.push(format!("registro da obra: {err}"));
                continue;
            }
        };
        if record.is_empty() {
            // O registro F2 (`autofetch:v3:o:`) nasce do ACEITE (`enqueue_obra`/`marker_meta`),
            // não do Node: sem ele não há `pool`, `acceptedAt` nem `overflow` — nada a remover.
            report.skip("evict-no-record");
            continue;
        }
        // Prova do EVENTO: o hash ready é pool `br` + `dubbed` no registro —
        // a MESMA régua que a política TS apagada usava.
        let current_ready_is_br = ready_hashes.iter().any(|hash| {
            record
                .iter()
                .any(|entry| entry.hash.eq_ignore_ascii_case(hash) && is_br_ready(entry))
        });
        let prior = match kv.get_json(&br_ready_key(&digest), now_ms) {
            Ok(value) => value.is_some(),
            Err(err) => {
                report.errors.push(format!("br-ready de {digest}: {err}"));
                continue;
            }
        };
        if !current_ready_is_br && !prior {
            report.skip("evict-no-br-proof");
            continue;
        }
        // Paridade com o `noteBrReady` do TS: só o ready comprovadamente
        // br+dubbed grava a evidência (prova do EVENTO, não do aceite).
        if current_ready_is_br {
            if let Err(err) = kv.put_json(
                &br_ready_key(&digest),
                &json!({ "at": now_ms }),
                work.br_ready_ttl_seconds.max(1),
                now_ms,
            ) {
                report.errors.push(format!("br-ready de {digest}: {err}"));
            }
        }
        let items = match items_of(kv, work, &digest, &record, now_ms) {
            Ok(items) => items,
            Err(err) => {
                report.errors.push(format!("fatos da obra: {err}"));
                continue;
            }
        };
        let facts = EvictFacts {
            current_ready_is_br,
            work_has_prior_br_ready: prior,
            now_ms,
            items,
        };
        let mut gates = config.gates;
        gates.max_per_run = left.min(config.gates.max_per_run);
        let plan = evict_step::plan_hashes(&facts, &gates);
        report.absorb(plan.skips);
        if plan.hashes.is_empty() {
            continue;
        }
        left = left.saturating_sub(plan.hashes.len());
        report.requested += plan.hashes.len();
        match io.evict(&plan.hashes).await {
            Ok(removed) => {
                report.removed += removed.len();
                let mut errors = Vec::new();
                report.marked += mark_removed(
                    kv,
                    work.account,
                    &removed,
                    &config.marks,
                    now_ms,
                    &mut errors,
                );
                report.errors.extend(errors);
            }
            // Capacidade/kill-switch da PORTA (ela lê a mesma env da F6 e o
            // kill global da limpeza): não é falha, é "desligado".
            Err(message) if kind_of(&message) == "unsupported" => report.skip("evict-off"),
            Err(message) => report.errors.push(format!("evict: {message}")),
        }
    }
    report
}

/// `pool == "br" && dubbed` da entrada do registro.
fn is_br_ready(entry: &ObraRecordEntry) -> bool {
    entry.pool == "br" && entry.dubbed
}

fn br_ready_key(digest: &str) -> String {
    format!("{BR_READY_PREFIX}{digest}")
}

/// Digest de obra é sha256 em hex: qualquer outra forma criaria chave fora dos
/// prefixos `o:`/`er:` (mesma régua de `state_v3.rs:313`).
fn digest_ok(digest: &str) -> bool {
    !digest.is_empty() && digest.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `obra` do marker DESTE hash, quando o marker é o completo (Fase 6).
fn marker_digest(
    kv: &NativeKv,
    work: &ReadyWork<'_>,
    hash: &str,
    now_ms: i64,
) -> Result<Option<String>, String> {
    let key = marker_key(work.adapter_id, work.account, hash);
    let Some(value) = kv.get_json(&key, now_ms)? else {
        return Ok(None);
    };
    Ok(marker_obra(&MarkerValue::from_json(&value))
        .filter(|digest| digest_ok(digest))
        .map(str::to_string))
}

/// Um [`EvictItem`] por entrada do registro. Só o que o KV prova entra; o que a
/// porta prova (nome, blindagem BR) fica explicitamente ausente.
fn items_of(
    kv: &NativeKv,
    work: &ReadyWork<'_>,
    digest: &str,
    record: &[ObraRecordEntry],
    now_ms: i64,
) -> Result<Vec<EvictItem>, String> {
    let mut items = Vec::with_capacity(record.len());
    for entry in record {
        let hash = entry.hash.trim().to_ascii_lowercase();
        if hash.is_empty() {
            continue;
        }
        let marker = marker_of(kv, work, &hash, now_ms)?;
        let blocked = alive(kv, &adrm_key(work.account, &hash), now_ms)?;
        items.push(EvictItem {
            transfer_id: marker
                .as_ref()
                .and_then(marker_transfer_id)
                .map(str::to_string),
            // A porta prova o NOME autoritativo e aplica a blindagem BR nele;
            // este lado NUNCA inventa nome.
            name: None,
            pool: entry.pool.clone(),
            overflow: entry.overflow,
            marker_matches_work: marker.as_ref().and_then(marker_obra) == Some(digest),
            // `adrm` NEGA a posse: hash apagado de propósito não é nosso
            // (`alldebrid_cleanup.rs:20`).
            owned: alive(kv, &adsub_key(work.account, &hash), now_ms)? && !blocked,
            held: alive(kv, &adhold_key(work.account, &hash), now_ms)?,
            protected: alive(kv, &adprot_key(work.account, &hash), now_ms)?,
            // Retenção BR pelo filename real é prova da PORTA (mais forte).
            br_retained: false,
            accepted_at: entry.accepted_at as i64,
            hash,
        });
    }
    Ok(items)
}

fn marker_of(
    kv: &NativeKv,
    work: &ReadyWork<'_>,
    hash: &str,
    now_ms: i64,
) -> Result<Option<MarkerValue>, String> {
    let key = marker_key(work.adapter_id, work.account, hash);
    Ok(kv
        .get_json(&key, now_ms)?
        .map(|value| MarkerValue::from_json(&value)))
}

fn alive(kv: &NativeKv, key: &str, now_ms: i64) -> Result<bool, String> {
    Ok(kv.get_json(key, now_ms)?.is_some())
}

/// `adrm` de cada hash removido — o anti-reenchimento do Node. Devolve quantos
/// foram gravados; falha de um hash vira erro do relatório, nunca silêncio.
fn mark_removed(
    kv: &NativeKv,
    account: &str,
    removed: &[String],
    marks: &MarkGates,
    now_ms: i64,
    errors: &mut Vec<String>,
) -> usize {
    if !marks.enabled {
        return 0;
    }
    let mut marked = 0;
    for hash in removed {
        match kv.put_json(
            &adrm_key(account, hash),
            &json!({ "at": now_ms }),
            marks.ttl_seconds,
            now_ms,
        ) {
            Ok(()) => marked += 1,
            Err(err) => errors.push(format!("adrm de {hash}: {err}")),
        }
    }
    marked
}

/// TTL do `adrm` em SEGUNDOS — o `Math.floor(ttlMs/1000)` do Node. O piso de 1
/// só garante que a marca não nasça vencida.
fn reupload_ttl_seconds() -> i64 {
    let ms = std::env::var(REUPLOAD_TTL_ENV)
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(DEFAULT_REUPLOAD_TTL_MS);
    ((ms / 1000.0).floor() as i64).max(1)
}

/// Prefixo de taxonomia do erro da porta (`ports.rs:227`).
fn kind_of(message: &str) -> &str {
    message.split(':').next().unwrap_or("").trim()
}

#[cfg(test)]
#[path = "evict_job_tests.rs"]
mod tests;
