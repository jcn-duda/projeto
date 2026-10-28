//! Lado do PACK do Season Pack Fill: o release que ficou pronto invalida as
//! buscas da temporada registradas pelo efeito `season_key`.
//!
//! O outro lado ([`super::season_step`]) grava `<adapter>:<conta>:<imdb>:
//! <temporada> → buscas`. Aqui o pack pronto consome essa entrada e apaga do
//! cache de streams as buscas daquela temporada — o `cache.forgetMany(keys)` de
//! `autofetch-recheck.ts:277-284`.
//!
//! # De onde vêm os fatos (nada inventado)
//!
//! O recheck do gateway só conhece hash, estado e id de transferência: o status
//! do debrid não carrega título. Os fatos que a régua pura precisa chegam no
//! lote `autofetch_batch` (`imdbId` e `season` do pedido, `title`/`name` do item)
//! e são persistidos por hash no lote do recheck ([`SeasonHint`] em
//! `Lot::season_hints`). `is_pack` NÃO é persistido: é derivado do título com a
//! MESMA régua do TS (`isSeasonPackFillEligible(stream, season ??
//! null)`, `autofetch-runner.ts:66`), então a decisão continua sendo um porte e
//! não uma adivinhação.
//!
//! # Divergências com o Node (dívida documentada, não silenciosa)
//!
//! - `isPack`: o Node PERSISTE o booleano no lote (`autofetch-lot-state.ts:7`,
//!   `{imdbId, season, episode, isPack}`, sem título); aqui o fato persistido
//!   é o TÍTULO e o `is_pack` é derivado no preenchimento. Um lote escrito
//!   pelo Node (sem `title`) é lido sem erro e cai em `not-pack`: falha
//!   fechada, nunca aceite falso.
//! - `cacheCheck` do Real-Debrid é DINÂMICO no Node (`debrid/registry.ts:66`:
//!   ledger ligado + oráculo disponível). [`cache_check_honest`] é estático e
//!   responde `false` para `realdebrid`, então lote de RD não preenche aqui —
//!   de novo falha fechada. Fiar isso exige levar
//!   `capabilities().cache_known` da fábrica até este passo; a porta
//!   `DebridIo` (trait `AutofetchDebrid`) não o expõe.
//!
//! # Ordem à prova de falso aceite
//!
//! `peek` → `sink` → `take`. O índice da temporada só é consumido DEPOIS de a
//! invalidação confirmar: cache de streams indisponível (ou sem sink
//! registrado) deixa o registro vivo e a passagem seguinte tenta de novo.
//! Consumir antes transformaria uma falha de I/O em perda silenciosa do índice —
//! e o pack pronto nunca mais invalidaria aquelas buscas.
//!
//! # Sem rede
//!
//! Este passo não fala com debrid nem com indexer: só KV e o cache de streams.
//! A credencial já foi resolvida antes, porque `ready` só existe depois do poll.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use adom_autofetch::v3::SeasonGap;
use adom_core::{cache_check_honest, is_season_pack_fill_eligible};
use adom_index::NativeKv;
use serde::{Deserialize, Serialize};

use super::season_step::{self, SeasonRegister, SeasonStepConfig};

/// Porta de invalidação do cache de streams (`cache.forgetMany` do Node).
///
/// Recebe as chaves de busca da temporada e devolve `Err` quando NÃO apagou —
/// erro aqui NÃO consome o índice.
pub(crate) type SeasonFillSink = Arc<dyn Fn(&[String]) -> Result<(), String> + Send + Sync>;

/// O que o lote declarou sobre o release, por hash.
///
/// Persistido no lote do recheck (sobrevive a restart, como o `seasonHints` do
/// Node em `autofetch-lot-state.ts`). Nenhum campo é inventado: `imdb_id` e
/// `season` vêm do payload do pedido e `title` do item do lote.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SeasonHint {
    /// IMDb do pedido (`payload.imdbId`) — sem ele não há chave de temporada.
    pub(crate) imdb_id: Option<String>,
    /// Temporada DECLARADA pela obra (`payload.season`); `None` nunca vira S1.
    pub(crate) season: Option<i64>,
    /// Título do release (`stream.title || stream.name || ''` no TS).
    pub(crate) title: String,
}

/// Contadores de uma passagem de preenchimento.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct FillReport {
    /// Packs que PREENCHERAM: índice consumido nesta passagem.
    pub(crate) filled: usize,
    /// Buscas da temporada entregues ao cache de streams.
    pub(crate) invalidated: usize,
    /// Motivo → contagem (o mesmo mapa de skips do painel).
    pub(crate) skips: BTreeMap<String, usize>,
    pub(crate) errors: Vec<String>,
}

impl FillReport {
    fn skip(&mut self, label: &str) {
        *self.skips.entry(label.to_string()).or_default() += 1;
    }
}

/// Um pack pronto → invalidação das buscas da temporada dele.
///
/// `ready` é o que o recheck viu ficar `ready` nesta passagem; o mesmo hash pode
/// aparecer em passagens diferentes em lotes diferentes (outra busca), e o
/// índice é por temporada, então repetir é idempotente.
pub(crate) fn fill(
    kv: &NativeKv,
    config: &SeasonStepConfig,
    sink: Option<&SeasonFillSink>,
    adapter_id: &str,
    account: &str,
    ready: &[SeasonHint],
    now_ms: i64,
) -> FillReport {
    let mut report = FillReport::default();
    // `adapter.cacheCheck` do TS: só serviço que promete cache tem busca em
    // cache para invalidar. `cache_check_honest` é a régua canônica do crate.
    let cache_check = cache_check_honest(adapter_id);
    for hint in ready {
        // `isPack` do TS, na ordem que a régua exige: sem temporada declarada
        // não há título a provar, e a resposta certa é `NoDeclaredSeason` (não
        // `NotPack`) — a temporada declarada é avaliada antes do match.
        let is_pack = match hint.season {
            None => cache_check,
            Some(season) => cache_check && is_season_pack_fill_eligible(&hint.title, Some(season)),
        };
        let facts = season_step::SeasonFillFacts {
            title: &hint.title,
            gap: SeasonGap {
                season: hint.season,
            },
            is_pack,
        };
        let season = match season_step::plan_fill(config, facts) {
            season_step::FillStep::Skip(reason) => {
                report.skip(reason.as_str());
                continue;
            }
            season_step::FillStep::Fill { season } => season,
        };
        // `hint.imdbId &&` do TS: a chave do índice é por obra + temporada.
        let Some(imdb_id) = hint.imdb_id.as_deref() else {
            report.skip("season-no-imdb");
            continue;
        };
        // Sem sink não há quem apague: o índice fica intacto de propósito.
        let Some(sink) = sink else {
            report.skip("season-no-sink");
            continue;
        };
        let target = SeasonRegister::target(adapter_id, account, imdb_id, season);
        let keys = match season_step::peek(kv, &target, now_ms) {
            Ok(keys) => keys,
            Err(err) => {
                report.errors.push(format!("índice da temporada: {err}"));
                continue;
            }
        };
        if keys.is_empty() {
            // Nenhuma busca registrada: nada a invalidar (não é "preencheu").
            report.skip("season-empty");
            continue;
        }
        if let Err(err) = sink(&keys) {
            report
                .errors
                .push(format!("invalidação do pack S{season}: {err}"));
            continue;
        }
        if let Err(err) = season_step::take(kv, &target, now_ms) {
            report.errors.push(format!("índice da temporada: {err}"));
            continue;
        }
        report.filled += 1;
        report.invalidated += keys.len();
        eprintln!(
            "[autofetch] pack S{season} de {imdb_id} pronto; {} busca(s) da temporada invalidada(s)",
            keys.len()
        );
    }
    report
}

/// Sink do CICLO (registrado UMA vez no boot do worker, `boot::spawn_at`).
pub(crate) fn register(sink: SeasonFillSink) {
    *lock(&shared().sink) = Some(sink);
}

/// Sink registrado, se o ciclo já subiu com o `streams.db` disponível.
pub(crate) fn sink() -> Option<SeasonFillSink> {
    lock(&shared().sink).clone()
}

struct Shared {
    sink: Mutex<Option<SeasonFillSink>>,
}

fn shared() -> &'static Shared {
    static SHARED: OnceLock<Shared> = OnceLock::new();
    SHARED.get_or_init(|| Shared {
        sink: Mutex::new(None),
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
#[path = "season_fill_tests.rs"]
mod tests;
