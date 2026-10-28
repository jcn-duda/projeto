//! Efeitos de cauda com dono nativo (T3-L7a e seguintes).
//!
//! O gateway DECIDE e MONTA os efeitos (`adom_search`); este módulo decide QUEM
//! os executa:
//!
//! - `dub_audit` — interrogatório de áudio, nativo desde a T3-L7a;
//! - `autofetch_batch`, `br_probe` e `season_key` — trabalho do worker nativo do
//!   Chupim: com o worker LIGADO o efeito vira um [`Job`](crate::autofetch)
//!   publicado no canal ([`NativeWorkQueue`]); em `prepared` segue ao Node, como
//!   sempre (a leva do flip é outra);
//! - kinds com dono registrado por outro módulo ([`NativeEffectSink`], ex.
//!   `rd_warmer`), que responde pelo próprio kill-switch;
//! - todo o resto vai ao alvo de sempre (`NodeTailEffects`), na ordem em que
//!   chegou.
//!
//! Regra única: efeito com dono nativo só é consumido quando o dono está LIGADO
//! **e** aceitou. Escopo de conta que não se deriva ou canal cheio NÃO somem —
//! voltam ao Node na mesma posição e contam em `rejected` (log curto).
//!
//! Aqui também entra a ÚNICA porta da chave de debrid do worker nativo: o
//! `encoded` do lote alimenta o cofre em RAM (`autofetch::vault`) ANTES de
//! qualquer delegação — inclusive quando o lote só tem `dub_audit`. O cofre não
//! grava em KV, não loga e não serializa; sem `AUTOFETCH_WORKER=on` ele nem
//! existe.
//!
//! A drenagem é fire-and-forget: a resposta do `/internal/search/effects` é
//! 202 e o interrogatório nunca entra no caminho de quem pediu a lista.

use std::sync::Arc;

use adom_search::orchestrator::{EffectsBatch, RouteFuture, TailEffects};
use adom_search::{EffectEntry, EffectsResponse};
use serde_json::{Map, Value};

use crate::autofetch::{shared_vault, Vault};
use crate::dub_audit::{self, DubAudit};

/// Efeito cujo dono virou o gateway.
pub const DUB_AUDIT: &str = "dub_audit";
/// Lote pós-debrid do Chupim (`items`/`cached`/`known`/`searchKey`).
pub const AUTOFETCH_BATCH: &str = "autofetch_batch";
/// Sonda dirigida de BR dublado (`mode` evidence/upgrade).
pub const BR_PROBE: &str = "br_probe";
/// LRU de temporadas com pack pronto (`adapter_id` + `account`).
pub const SEASON_KEY: &str = "season_key";

/// Dono de um `kind` que mora FORA deste arquivo (`rd_warmer`…). Quem registra
/// é responsável pelo próprio kill-switch: aqui não se lê config alheia.
pub(crate) trait NativeEffectSink: Send + Sync {
    /// Entrega o efeito já montado (o mesmo payload que iria ao Node) e o
    /// escopo `adapter:sha256(chave)` derivado do `encoded` da busca. Sem
    /// escopo o efeito NÃO é entregue aqui: volta ao Node (`Deferred`).
    fn offer(&self, kind: &str, payload: &Value, scope: Option<&str>);
}

/// Canal do worker nativo do Chupim.
///
/// Produção é o `AutofetchHandle` do módulo `autofetch` (`enabled` =
/// `status().enabled`, `submit` = `submit(Job { scope, payload })`); o teste
/// injeta um gravador. A montagem do `Job` fica com o dono do canal porque o
/// tipo dele não atravessa a fronteira do módulo.
pub(crate) trait NativeWorkQueue: Send + Sync {
    /// `false` = worker em `prepared` (ou sem laço): o efeito é do Node.
    fn enabled(&self) -> bool;
    /// `false` = canal ausente/cheio: quem publica decide (aqui, volta ao Node).
    fn submit(&self, scope: &str, payload: &Map<String, Value>) -> bool;
}

/// Intercepta os efeitos com dono nativo e delega o resto ao Node.
pub struct NativeTailEffects {
    rest: Arc<dyn TailEffects>,
    audit: Arc<DubAudit>,
    /// Cofre do processo: `None` com a trava desligada (nada guarda chave).
    vault: Option<Arc<Vault>>,
    /// Canal do Chupim: `None` até a fiação de produção apontar o handle.
    worker: Option<Arc<dyn NativeWorkQueue>>,
    /// Donos registrados por outros módulos, na ordem de registro.
    sinks: Vec<(&'static str, Arc<dyn NativeEffectSink>)>,
}

impl NativeTailEffects {
    /// Produção: cofre vem de `AUTOFETCH_WORKER=on` (sem a trava, `None`).
    pub fn new(rest: Arc<dyn TailEffects>, audit: Arc<DubAudit>) -> Self {
        Self::with_vault(rest, audit, shared_vault())
    }

    /// Cofre injetado (teste, ou o processo que já criou o seu).
    pub fn with_vault(
        rest: Arc<dyn TailEffects>,
        audit: Arc<DubAudit>,
        vault: Option<Arc<Vault>>,
    ) -> Self {
        Self {
            rest,
            audit,
            vault,
            worker: None,
            sinks: Vec::new(),
        }
    }

    /// Registra o dono de um `kind` de outro módulo — sem reabrir este arquivo
    /// para cada subsistema que ganha dono nativo.
    ///
    pub(crate) fn with_sink(mut self, kind: &'static str, sink: Arc<dyn NativeEffectSink>) -> Self {
        self.sinks.push((kind, sink));
        self
    }

    /// Liga o canal do worker do Chupim (`AutofetchHandle`).
    ///
    pub(crate) fn with_queue(mut self, queue: Arc<dyn NativeWorkQueue>) -> Self {
        self.worker = Some(queue);
        self
    }

    /// Destino de UM efeito: só decide e entrega ao dono, sem I/O.
    fn route(&self, effect: &EffectEntry, encoded: &str) -> Routed {
        if effect.kind == DUB_AUDIT {
            // Payload fora da forma é REJEITADO, nunca vira varredura.
            return match dub_audit::parse_effect(&effect.payload) {
                Some((_adapter, _api_key, candidates)) => {
                    self.audit.offer(&candidates);
                    Routed::Native
                }
                None => {
                    eprintln!("[audit] efeito dub_audit rejeitado (payload inválido)");
                    Routed::Rejected
                }
            };
        }

        // Trabalho do Chupim: só sai do Node com o worker LIGADO. Em `prepared`
        // o caminho é o de hoje, inclusive para o pool da sonda.
        if is_work_kind(&effect.kind) {
            if let Some(queue) = self.worker.as_deref().filter(|queue| queue.enabled()) {
                let Some(scope) = self.scope_for(&effect.payload, encoded) else {
                    eprintln!(
                        "[effects] {} sem escopo de conta; segue ao Node",
                        effect.kind
                    );
                    return Routed::Deferred;
                };
                if queue.submit(&scope, &effect.payload) {
                    return Routed::Native;
                }
                eprintln!(
                    "[effects] {} recusado pelo canal; segue ao Node",
                    effect.kind
                );
                return Routed::Deferred;
            }
        }

        // Donos registrados por outro módulo (`rd_warmer` diante do Node). A
        // chave do serviço não viaja no payload: o escopo sai do cofre, que é
        // a mesma leitura de `dk` do `/resolve`. Sem escopo, o efeito segue ao
        // Node (nunca se perde por falta de credencial local).
        if let Some((_, sink)) = self.sinks.iter().find(|(kind, _)| *kind == effect.kind) {
            let Some(scope) = self.scope_for(&effect.payload, encoded) else {
                eprintln!(
                    "[effects] {} sem escopo de conta; segue ao Node",
                    effect.kind
                );
                return Routed::Deferred;
            };
            sink.offer(
                &effect.kind,
                &Value::Object(effect.payload.clone()),
                Some(&scope),
            );
            return Routed::Native;
        }
        Routed::Forward
    }

    /// Escopo `adapter:sha256(chave)` do efeito — o mesmo valor que a fila, o
    /// marker e o `dead:` do Chupim usam.
    ///
    /// `season_key` já traz `adapter_id` + `account` (o digest) no payload, e o
    /// escopo sai sem reabrir o selo do `encoded`. Os outros dois não carregam
    /// conta: o caminho é o do cofre (`Vault::ingest` → `debrid_config` +
    /// `Vault::scope_of`), a MESMA leitura do `dk` que o `/resolve` faz.
    fn scope_for(&self, payload: &Map<String, Value>, encoded: &str) -> Option<String> {
        if let Some(scope) = payload_scope(payload) {
            return Some(scope);
        }
        if encoded.is_empty() {
            return None;
        }
        let vault = self.vault.as_deref()?;
        vault.ingest(encoded, adom_sources::now_ms())
    }
}

/// Destino de um efeito do lote.
enum Routed {
    /// Consumido aqui: nada vai ao Node.
    Native,
    /// Sem dono nativo ligado: segue ao Node, como hoje.
    Forward,
    /// Tinha dono e o dono recusou (sem escopo ou canal cheio): volta ao Node,
    /// porque trabalho não se perde em silêncio.
    Deferred,
    /// Forma inválida: rejeitado sem ir a lugar nenhum.
    Rejected,
}

impl TailEffects for NativeTailEffects {
    fn effects<'a>(&'a self, batch: EffectsBatch) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async move {
            // A chave do usuário chega UMA vez por lote. O cofre é alimentado
            // antes de qualquer `continue`/delegação — lote só com `dub_audit`
            // também ensina a conta ao worker.
            if let Some(vault) = self.vault.as_deref() {
                vault.ingest(&batch.encoded, adom_sources::now_ms());
            }
            let mut rest = Vec::with_capacity(batch.effects.len());
            let mut accepted = 0i64;
            let mut rejected = 0i64;
            for effect in batch.effects {
                match self.route(&effect, &batch.encoded) {
                    Routed::Native => accepted += 1,
                    Routed::Forward => rest.push(effect),
                    // Segue ao Node: o aceite dele entra na conta ao lado.
                    Routed::Deferred => {
                        rejected += 1;
                        rest.push(effect);
                    }
                    Routed::Rejected => rejected += 1,
                }
            }
            let mut ok = true;
            if !rest.is_empty() {
                let response = self
                    .rest
                    .effects(EffectsBatch {
                        encoded: batch.encoded,
                        effects: rest,
                    })
                    .await?;
                ok = response.ok;
                accepted += response.accepted;
                rejected += response.rejected;
            }
            // Um drain por vez é regra do próprio `DubAudit` (`in_flight`).
            if self.audit.pending() > 0 {
                let audit = self.audit.clone();
                tokio::spawn(async move {
                    audit.drain().await;
                });
            }
            Ok(EffectsResponse {
                ok,
                accepted,
                rejected,
            })
        })
    }
}

/// Os três kinds do worker nativo do Chupim.
fn is_work_kind(kind: &str) -> bool {
    kind == AUTOFETCH_BATCH || kind == BR_PROBE || kind == SEASON_KEY
}

/// Escopo já digerido no payload (`season_key`). O `account` É o
/// `account_scope` (sha256 da chave), então `Vault::scope_of` não se aplica de
/// novo — hashear o digest daria um escopo que a fila nunca viu.
fn payload_scope(payload: &Map<String, Value>) -> Option<String> {
    let adapter = first_str(payload, &["adapterId", "adapter_id", "service"])?;
    let account = first_str(payload, &["account", "accountScope"])?;
    if account == "none" {
        return None;
    }
    Some(format!("{}:{account}", adapter.to_ascii_lowercase()))
}

fn first_str<'a>(payload: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .filter_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
}

#[cfg(test)]
#[path = "tail_effects_tests.rs"]
mod tests;
