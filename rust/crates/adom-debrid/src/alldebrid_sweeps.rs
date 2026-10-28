//! Varreduras de CONTEÚDO da AllDebrid (`sweepDead`, `sweepUndubbed`,
//! reconcile da posse e revalidate de represados) — a parte destrutiva que
//! ainda morava no Node (`alldebrid-cleanup.ts`, `alldebrid-reconcile.ts`,
//! `alldebrid-suppressed-revalidate.ts`).
//!
//! Divisão, na ordem em que a decisão acontece:
//!
//! - `alldebrid_sweeps_types.rs`: [`SweepMode`], [`SweepKind`], [`Reason`],
//!   [`MagnetRow`] e [`SweepPlan`];
//! - `alldebrid_sweeps_facts.rs`: [`SweepFacts`] (entradas) e [`SweepConfig`]
//!   (réguas numéricas com os defaults do Node);
//! - `alldebrid_sweeps_plan.rs`: as quatro funções PURAS
//!   ([`plan_sweep_dead`], [`plan_sweep_undubbed`], [`plan_reconcile`],
//!   [`plan_revalidate`]);
//! - `alldebrid_sweeps_apply.rs`: [`apply_plan`], o executor com HTTP
//!   injetado ([`SweepHttp`]), lotes e `may_delete` fail-closed.
//!
//! ## Réguas que valem nas QUATRO varreduras
//!
//! 1. **Sem inventário ninguém sai.** `known_before: None` ⇒ `delete` vazio e
//!    `skip` = `inventory_missing` em toda linha — o `may_delete` fail-closed
//!    do núcleo aplicado à rodada inteira (o `sweepDead` do TS não consultava
//!    `knownBefore`; aqui consulta).
//! 2. **Hold do autofetch preserva** ([`Reason::Held`]) — a mesma trava do
//!    `protected.ts` (invariante 6: autofetch × `dropUncached`).
//! 3. **Preexistente preserva** ([`Reason::Preexisting`]): o que já era do
//!    usuário antes do upload não é acervo nosso.
//! 4. **Retenção BR preserva** ([`Reason::RetentionBr`], `adprot:v1`): pack BR
//!    multiobra retido é acervo caro. Mais restritivo que o Node, que apagava
//!    morto retido.
//! 5. **`adrm:v1` preserva na reconciliação** ([`Reason::Marked`]): hash que a
//!    limpeza já apagou de propósito não é reapagado.
//!
//! ## Kill-switch
//!
//! Nenhuma função daqui lê env: o chamador passa [`SweepMode`]
//! (`Off`/`ReadOnly`/`Apply`, ou [`SweepMode::from_flags`] com as duas flags
//! do corte). `Off`/`ReadOnly` não chamam `DELETE`; `Apply` ainda reavalia
//! `may_delete` no instante do delete.
//!
//! ## Fora desta fatia (wiring no gateway, não feito aqui)
//!
//! Montar os fatos (`/magnet/status` com arquivos para a prova de áudio,
//! `adsub`/`adrm`/`adprot` do `cache.db`, hold volátil e fila `sup:`), o
//! agendamento (intervalo mínimo e anti-reentrada por conta) e a gravação do
//! `adrm` do que `SweepOutcome::removed` provar que saiu.

#[path = "alldebrid_sweeps_types.rs"]
mod types;
pub use types::{MagnetRow, Reason, SweepKind, SweepMode, SweepPlan};

#[path = "alldebrid_sweeps_facts.rs"]
mod facts;
pub use facts::{SweepConfig, SweepFacts};

#[path = "alldebrid_sweeps_plan.rs"]
mod plan;
pub use plan::{plan_reconcile, plan_revalidate, plan_sweep_dead, plan_sweep_undubbed};

#[path = "alldebrid_sweeps_apply.rs"]
mod apply;
pub use apply::{apply_plan, SweepHttp, SweepHttpError, SweepOutcome, SweepStop};

#[cfg(test)]
#[path = "alldebrid_sweeps_tests.rs"]
mod sweep_tests;

#[cfg(test)]
#[path = "alldebrid_sweeps_tests_apply.rs"]
mod sweep_apply_tests;
