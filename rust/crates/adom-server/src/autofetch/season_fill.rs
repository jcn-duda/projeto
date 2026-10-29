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
//! - `cacheCheck` RESOLVIDO (era a dívida do `false` estático do RD):
//!   no Node o flag é DINÂMICO (`debrid/registry.ts:66`: ledger ligado +
//!   oráculo disponível). [`cache_check_honest`] só conhece o booleano ESTÁTICO
//!   do adaptador (e responde `false` para `realdebrid`), por isso o veredito
//!   chega aqui como [`CacheProof`]: a prova viva vem do adaptador da conta
//!   (`AutofetchDebrid::cache_known`, que em `autofetch/ports.rs` é
//!   `capabilities().cache_known` — no RD, o ledger `rdc:v2` armado em
//!   `build.rs`). Sem prova o passo NÃO preenche e o motivo vai ao relatório:
//!   `known: false` nunca vira "não há cache".
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
//! A credencial já foi resolvida antes, porque `ready` só existe depois do poll
//! — e a prova de `cacheCheck` (um booleano do adaptador já construído) também
//! chega pronta, sem I/O.

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

/// Prova VIVA do `cacheCheck` do serviço, trazida da fábrica até este passo.
///
/// O Registry do Node resolve o flag POR CONTA (no Real-Debrid: ledger
/// `rdc:v2` + oráculo); [`cache_check_honest`] só repete o booleano exportado
/// pelo adaptador. Sem esta prova a resposta honesta é `known: false` — e então
/// o pack NÃO preenche.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CacheProof {
    /// O adaptador desta conta prova o veredito (`AutofetchDebrid::cache_known`).
    Proven,
    /// Não se perguntou / não há prova viva; o motivo vai ao relatório.
    Unproven(&'static str),
}

/// As TRÊS respostas do `cacheCheck` — nunca duas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CacheCheck {
    /// Há cache de streams com ⚡ para o pack invalidar.
    HasCache,
    /// O adaptador DECLARA `cacheCheck: false` (Debrid-Link): nada a invalidar.
    DeclaredNone,
    /// `known: false`: não se perguntou, então não há veredito.
    Unknown(&'static str),
}

/// Único serviço cujo `cacheCheck` é dinâmico no Node (`debrid/registry.ts:66`).
const DYNAMIC_CACHE_CHECK: &str = "realdebrid";

/// Veredito do `cacheCheck` de UM serviço.
///
/// Estático fora do Real-Debrid (o adaptador é a palavra final) e provado pela
/// fábrica dentro dele. Estático `false` num serviço dinâmico é AUSÊNCIA de
/// prova, não prova de ausência — por isso `Unknown`, que rotula o skip.
fn cache_verdict(adapter_id: &str, proof: CacheProof) -> CacheCheck {
    match proof {
        CacheProof::Proven => CacheCheck::HasCache,
        CacheProof::Unproven(reason) => match (adapter_id, cache_check_honest(adapter_id)) {
            (DYNAMIC_CACHE_CHECK, _) => CacheCheck::Unknown(reason),
            (_, true) => CacheCheck::HasCache,
            (_, false) => CacheCheck::DeclaredNone,
        },
    }
}

/// Um pack pronto → invalidação das buscas da temporada dele.
///
/// `cache` é o veredito do `cacheCheck` desta passagem ([`CacheProof`]): sem
/// prova viva o pack não preenche, e o motivo entra em `skips`
/// (`season-cache-unknown-<motivo>`).
///
/// `ready` é o que o recheck viu ficar `ready` nesta passagem; o mesmo hash pode
/// aparecer em passagens diferentes em lotes diferentes (outra busca), e o
/// índice é por temporada, então repetir é idempotente.
// Os 8 argumentos são fatos independentes do passo (KV, régua, sink, escopo,
// prova de cache, lote, relógio); agrupá-los esconderia a origem de cada um.
#[allow(clippy::too_many_arguments)]
pub(crate) fn fill(
    kv: &NativeKv,
    config: &SeasonStepConfig,
    sink: Option<&SeasonFillSink>,
    adapter_id: &str,
    account: &str,
    cache: CacheProof,
    ready: &[SeasonHint],
    now_ms: i64,
) -> FillReport {
    let mut report = FillReport::default();
    // `adapter.cacheCheck` do TS: só serviço que promete cache tem busca em
    // cache para invalidar. `cache_check_honest` é a régua estática; a prova
    // viva (RD: ledger + oráculo) entra por `cache`.
    let cache_check = match cache_verdict(adapter_id, cache) {
        CacheCheck::HasCache => true,
        CacheCheck::DeclaredNone => false,
        CacheCheck::Unknown(reason) => {
            // `known: false` NÃO é "nada em cache": sem pergunta o pack não
            // preenche, e o motivo fica no relatório do passo.
            for _ in ready {
                report.skip(&format!("season-cache-unknown-{reason}"));
            }
            return report;
        }
    };
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
