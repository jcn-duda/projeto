//! Varreduras destrutivas da AllDebrid no gateway: portas, freio e divisão.
//!
//! O núcleo (`adom_debrid::alldebrid_sweeps`) decide; aqui só se monta o que
//! ele precisa, se respeita o intervalo e se obedece ao freio. Nada neste
//! módulo inventa fato: o que o processo não consegue PROVAR vira `None` e o
//! plano fecha em `inventory_missing` (o `may_delete` fail-closed do núcleo
//! aplicado à rodada inteira).
//!
//! # Divisão dos arquivos
//!
//! - `al_sweeps.rs` (este): portas injetáveis e o vocabulário da rodada;
//! - `al_sweeps_run.rs`: estado, relógio, guard de anti-reentrada e execução
//!   (`Sweeper::tick` agendado, `Sweeper::run_kind` manual);
//! - `al_sweeps_stats.rs`: contadores cumulativos (RAM) e snapshot do painel;
//! - `al_sweeps_env.rs`: env, montagem e `spawn` (`SweepAdmin`/`SweepRuntime`);
//! - `al_sweeps_admin.rs`: `GET /sweeps` e `POST /sweeps/run` na 8711;
//! - `al_sweeps_facts.rs` / `al_sweeps_effects.rs` / `al_sweeps_native.rs`:
//!   fatos da rodada, efeitos de estado e as portas de produção.
//!
//! # Dono do agendamento
//!
//! O agendador NATIVO é o dono: `proxy::run` chama `spawn` UMA vez e mantém o
//! `SweepRuntime` vivo até o fim do `axum::serve`; o `main` não monta mais
//! nada. Não existe segundo laço nem segunda fila — a rota manual usa o MESMO
//! `Sweeper` e o MESMO guard de anti-reentrada do tick agendado.
//!
//! # O freio
//!
//! `DEBRID_AL_SWEEP_APPLY` é o freio (default **OFF**): `DEBRID_AL_CLEANUP=on`
//! só vira `Apply` com ele ligado. OFF = o diagnóstico read-only de sempre
//! (plano calculado, `DELETE` = 0, nenhum `adrm` gravado). Os demais
//! kill-switches:
//!
//! - `DEBRID_AL_CLEANUP` **ausente** ⇒ `ReadOnly`: monta o plano, loga os
//!   motivos, não apaga. `off` ⇒ `Off`: nem plano nem I/O.
//! - `DEBRID_AL_CLEANUP_KILL` ligado ⇒ volta a `ReadOnly` mesmo com o freio
//!   aberto.
//! - `DEBRID_AL_HOLDS` ausente/off ⇒ o hold do autofetch não está montado e o
//!   inventário sozinho não prova que um download em voo está protegido:
//!   `known_before = None` em toda rodada e nenhum hash sai.
//! - `DEBRID_AL_SWEEP_MS` (default 6 h, `0` desliga o agendamento) é o
//!   intervalo mínimo por tipo; cada tipo tem o próprio relógio (`last`), então
//!   a falha de um não antecipa nem atrasa os outros.
//!
//! # Concorrência
//!
//! UMA rodada em voo por processo (anti-reentrada): o segundo tick — ou o
//! manual que chega durante o agendado — devolve `reentered: true` sem tocar na
//! conta. O `FlightGuard` solta o `running` no `Drop`, inclusive se a tarefa for
//! abortada no shutdown.
//!
//! # O que a porta nativa prova
//!
//! `AllDebrid::sweep_magnet_list` entrega `id`, `hash`, o texto do `status`, o
//! `ready`, o `filename` e o `uploadDate` (segundos → ms) numa chamada;
//! `sweep_magnet_files` entrega os caminhos de UM magnet pronto, sob demanda e
//! só para os candidatos do `sweepUndubbed`. Posse (`adsub`), retenção
//! (`adprot`), anti-reenchimento (`adrm`) e a fila `sup:` vêm do `cache.db`
//! (fatos de [`facts`] + [`effects`]).
//!
//! # Inventário frio e guarda viva
//!
//! Rodada fria: o [`InventoryEnsure`] de produção tenta provar o snapshot
//! (UMA `/magnet/status` aguardada, régua do Node: conta − posse durável −
//! `submitted`; falhou ⇒ `inventory_missing` relatado, nada é inventado;
//! `DEBRID_AL_HOLDS` off deixa o peek `None` de qualquer jeito). A fonte
//! durável (`adprot`/`adhold`) ilegível fecha a rodada no PLANEJAMENTO (sem
//! plano e sem poda) e no INSTANTE do delete (`live_delete_ok` → veto): o que
//! não se consegue ler não pode virar "sem proteção".

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;

use adom_debrid::alldebrid_sweeps::{MagnetRow, SweepHttp, SweepHttpError, SweepKind};

#[path = "al_sweeps_env.rs"]
mod env;
pub(crate) use env::{spawn, SweepAdmin, SweepRuntime};

#[path = "al_sweeps_stats.rs"]
mod stats;
pub(crate) use stats::OutcomeSummary;

#[path = "al_sweeps_run.rs"]
mod run;
pub(crate) use run::Sweeper;

#[path = "al_sweeps_lookup.rs"]
mod lookup;

#[path = "al_sweeps_admin.rs"]
mod admin;
pub(crate) use admin::router as admin_router;

#[path = "al_sweeps_facts.rs"]
mod facts;
pub(crate) use facts::TickReport;

// `pub(crate)`: o catálogo da conta (`account_catalog`) reusa a ponte de
// inventário (`gated_snapshot`, `open_kv`) e o efeito `adrm` (`NativeEffects`).
#[path = "al_sweeps_native.rs"]
pub(crate) mod native;

#[path = "al_sweeps_effects.rs"]
pub(crate) mod effects;

#[cfg(test)]
#[path = "al_sweeps_tests.rs"]
mod tests;

/// Ordem fixa das quatro varreduras (diagnóstico estável no log).
pub(crate) const KINDS: [SweepKind; 4] = [
    SweepKind::Dead,
    SweepKind::Undubbed,
    SweepKind::Reconcile,
    SweepKind::Revalidate,
];

// ---------------------------------------------------------------------------
// Portas injetáveis: a produção é `native`, os testes usam duplos.
// ---------------------------------------------------------------------------

/// Listagem e delete da conta. `None` na listagem = não deu para saber
/// (auth/quota/rede): nenhum hash é planejado nesta rodada.
pub(crate) type RowsFuture<'a> = Pin<Box<dyn Future<Output = Option<Vec<MagnetRow>>> + Send + 'a>>;
pub(crate) type FilesFuture<'a> = Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + 'a>>;
pub(crate) type DeleteFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), SweepHttpError>> + Send + 'a>>;

pub(crate) trait SweepSource: Send + Sync {
    fn rows(&self) -> RowsFuture<'_>;
    /// Prova de áudio por id; fontes de teste podem omitir (fica sem prova).
    fn files(&self, _id: String) -> FilesFuture<'_> {
        Box::pin(async { None })
    }
    /// `id` vem por valor: a futura do delete só empresta `&self`.
    fn delete(&self, id: String) -> DeleteFuture<'_>;
}

/// `SweepHttp` do núcleo sobre as portas da conta. A guarda viva
/// (`guard_live`) relê os FATOS no instante do delete; `None` = ilegível e o
/// executor vetará (fail-closed).
struct SourceHttp<'a> {
    source: &'a dyn SweepSource,
    facts: &'a dyn FactSource,
}

impl SweepHttp for SourceHttp<'_> {
    fn delete(&self, id: &str) -> impl Future<Output = Result<(), SweepHttpError>> + Send {
        self.source.delete(id.to_string())
    }

    fn guard_live(&self, hash: &str) -> impl Future<Output = Option<bool>> + Send {
        let verdict = self.facts.live_delete_ok(hash);
        async move { verdict }
    }
}

/// Fatos que o PROCESSO consegue provar. Produção: `native::NativeFacts`.
pub(crate) trait FactSource: Send + Sync {
    /// Snapshot `knownBefore` vigente. `None` = sem referência autorizada.
    fn known_before(&self) -> Option<HashSet<String>>;
    fn held(&self, hash: &str) -> bool;
    fn retained(&self, hash: &str) -> bool;
    fn owned_at(&self, hash: &str) -> Option<i64>;
    fn marked(&self) -> HashSet<String>;
    /// Fila de represados (`sup:`) da conta — lida da represa nativa. Vazio =
    /// fila ilegível ou sem represados (o revalidate não condena por omissão).
    fn suppressed(&self) -> HashSet<String>;
    /// A fonte durável (`adprot`/`adhold` no `cache.db`) está LEGÍVEL? `false`
    /// = leitura que falha não prova "sem proteção": o planejamento inteiro
    /// fecha (mesma postura da listagem indisponível).
    fn durable_readable(&self) -> bool {
        true
    }
    /// Hold do hash COM prova de leitura: `None` = não deu para ler AGORA, e
    /// quem poda não pode tratá-lo como "sem hold" (fail-closed).
    fn held_checked(&self, hash: &str) -> Option<bool> {
        Some(self.held(hash))
    }
    /// Guarda VIVA no INSTANTE do delete: relê AGORA preexistente, hold e
    /// retenção do hash. `None` = não deu para saber (fail-closed: veto).
    /// Em produção os portos acima são leitura VIVA (peek do snapshot, hold
    /// volátil + `adhold`, `adprot`) — relê-los aqui é o que pega o que
    /// chegou DEPOIS de o plano fechar. Duplos de teste derivam igual. A
    /// fonte durável ilegível no instante do delete VETA junto: "não
    /// protegido" sem leitura não é veredito, é palpite.
    fn live_delete_ok(&self, hash: &str) -> Option<bool> {
        if !self.durable_readable() {
            return None;
        }
        let known = self.known_before()?;
        Some(!known.contains(hash) && !self.held(hash) && !self.retained(hash))
    }
}

/// Carregador do inventário frio: uma tentativa AGUARDADA de provar a
/// referência `knownBefore` quando a rodada acorda sem ela. Produção:
/// `native::NativeInventory` (UMA `/magnet/status` pela mesma régua do Node).
/// Falha NÃO é completada com suposição: o peek segue `None` e a rodada
/// inteira fecha em `inventory_missing`.
pub(crate) trait InventoryEnsure: Send + Sync {
    fn ensure(&self) -> EnsureFuture<'_>;
}

pub(crate) type EnsureFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
