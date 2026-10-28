//! Decisão PURA das quatro varreduras de conteúdo: fatos entram, [`SweepPlan`]
//! sai. Zero I/O — o executor (`alldebrid_sweeps_apply`) é quem fala com a API.
//!
//! A ordem das réguas é a do Node (`alldebrid-cleanup.ts`,
//! `alldebrid-reconcile.ts`, `alldebrid-suppressed-revalidate.ts`), com três
//! endurecimentos deliberados:
//!
//! 1. **Sem inventário ninguém sai** em NENHUMA das quatro — inclusive no
//!    `sweepDead`, que no TS não consultava `knownBefore`. É o `may_delete`
//!    fail-closed do núcleo aplicado à rodada inteira.
//! 2. **Retenção BR preserva também no `sweepDead`** (o TS apagava morto
//!    retido): pack BR multiobra retido é acervo caro, não lixo.
//! 3. **`sweepUndubbed` exige prova de ARQUIVO**: sem caminho de vídeo a
//!    linha fica (`no_audio_proof`) — título nunca condena.

use adom_core::foreign_verdict;

use super::facts::{SweepConfig, SweepFacts};
use super::types::{MagnetRow, Reason, SweepKind, SweepPlan};

/// Identidade da linha no plano: hash normalizado; linha sem hash usa `#<id>`
/// só para não perder o diagnóstico (nunca vira delete).
fn key_of(row: &MagnetRow) -> String {
    let hash = row.normalized_hash();
    if hash.is_empty() {
        format!("#{}", row.id.trim())
    } else {
        hash
    }
}

/// Rodada inteira suprimida: `delete` vazio e o mesmo motivo em toda linha.
fn denied(kind: SweepKind, rows: &[MagnetRow], reason: Reason) -> SweepPlan {
    let mut plan = SweepPlan::new(kind);
    for row in rows {
        plan.keep_with(key_of(row), reason);
    }
    plan
}

/// Fatos que seguram o magnet em TODA varredura: preexistente do usuário, hold
/// volátil do autofetch e retenção BR durável. `honor_mark` acrescenta
/// `adrm:v1` (só a reconciliação, como no Node/plano).
fn protected(facts: &SweepFacts<'_>, hash: &str, honor_mark: bool) -> Option<Reason> {
    if facts.known_before.is_some_and(|snap| snap.contains(hash)) {
        return Some(Reason::Preexisting);
    }
    if facts.held.contains(hash) {
        return Some(Reason::Held);
    }
    if facts.retained.contains(hash) {
        return Some(Reason::RetentionBr);
    }
    if honor_mark && facts.marked.contains(hash) {
        return Some(Reason::Marked);
    }
    None
}

/// Teto por rodada: os mais antigos primeiro; o excedente fica com
/// `cap_exceeded` (diagnóstico, nunca silêncio).
fn cap(plan: &mut SweepPlan, mut rows: Vec<&MagnetRow>, max: usize) {
    rows.sort_by_key(|row| row.uploaded_at_ms);
    for (index, row) in rows.into_iter().enumerate() {
        let hash = row.normalized_hash();
        if index < max {
            plan.queue_delete(hash);
        } else {
            plan.keep_with(hash, Reason::CapExceeded);
        }
    }
}

/// Varredura dos magnets em estado TERMINAL. Pronto é acervo (vence o texto);
/// data de upload ilegível não barra o morto (lixo em qualquer idade), mas data
/// PROVADA de magnet recente barra (`too_young`, piso do Node).
#[must_use]
pub fn plan_sweep_dead(
    rows: &[MagnetRow],
    facts: &SweepFacts<'_>,
    config: &SweepConfig,
) -> SweepPlan {
    let kind = SweepKind::Dead;
    if facts.known_before.is_none() {
        return denied(kind, rows, Reason::InventoryMissing);
    }
    let limit = config.age_limit(facts.now_ms);
    let mut plan = SweepPlan::new(kind);
    let mut pass: Vec<&MagnetRow> = Vec::new();
    for row in rows {
        let hash = row.normalized_hash();
        if hash.is_empty() {
            plan.keep_with(key_of(row), Reason::NoHash);
            continue;
        }
        if row.is_ready() {
            plan.keep_with(hash, Reason::Ready);
            continue;
        }
        if let Some(reason) = protected(facts, &hash, false) {
            plan.keep_with(hash, reason);
            continue;
        }
        if !row.is_dead() {
            plan.keep_with(hash, Reason::NotDead);
            continue;
        }
        if row.usable_id().is_none() {
            plan.keep_with(hash, Reason::MissingId);
            continue;
        }
        if row.uploaded_at_ms > 0 && row.uploaded_at_ms > limit {
            plan.keep_with(hash, Reason::TooYoung);
            continue;
        }
        pass.push(row);
    }
    cap(&mut plan, pass, config.max_per_round);
    plan
}

/// Varredura do que está pronto/antigo e NÃO serve a este addon: áudio
/// estrangeiro PROVADO nos arquivos. Ambíguo fica; marcador PT absolve;
/// ausência de arquivo não condena.
#[must_use]
pub fn plan_sweep_undubbed(
    rows: &[MagnetRow],
    facts: &SweepFacts<'_>,
    config: &SweepConfig,
) -> SweepPlan {
    let kind = SweepKind::Undubbed;
    if facts.known_before.is_none() {
        return denied(kind, rows, Reason::InventoryMissing);
    }
    let limit = config.age_limit(facts.now_ms);
    let (pt, en) = config.markers();
    let mut plan = SweepPlan::new(kind);
    let mut pass: Vec<&MagnetRow> = Vec::new();
    for row in rows {
        let hash = row.normalized_hash();
        if hash.is_empty() {
            plan.keep_with(key_of(row), Reason::NoHash);
            continue;
        }
        if row.is_active() {
            plan.keep_with(hash, Reason::Active);
            continue;
        }
        if let Some(reason) = protected(facts, &hash, false) {
            plan.keep_with(hash, reason);
            continue;
        }
        if row.usable_id().is_none() {
            plan.keep_with(hash, Reason::MissingId);
            continue;
        }
        let paths: Vec<&str> = row
            .files
            .iter()
            .map(String::as_str)
            .filter(|path| !path.is_empty())
            .collect();
        if paths.is_empty() {
            plan.keep_with(hash, Reason::NoAudioProof);
            continue;
        }
        match foreign_verdict(&row.name, &paths, &pt, &en) {
            "condena" => {}
            "absolve" => {
                plan.keep_with(hash, Reason::PtProof);
                continue;
            }
            _ => {
                plan.keep_with(hash, Reason::ForeignUnknown);
                continue;
            }
        }
        if row.uploaded_at_ms <= 0 {
            plan.keep_with(hash, Reason::NoUploadDate);
            continue;
        }
        if row.uploaded_at_ms > limit {
            plan.keep_with(hash, Reason::TooYoung);
            continue;
        }
        pass.push(row);
    }
    cap(&mut plan, pass, config.max_per_round);
    plan
}

/// Reconciliação da posse (`adsub`) com a conta real: só sai o que é NOSSO
/// (`ready`, nunca ativo), não é preexistente, não foi consultado por esta
/// busca, não tem `adrm`, não é re-add do usuário e já passou do piso de idade.
/// Conta abaixo do piso de ocupação não é reconciliada.
#[must_use]
pub fn plan_reconcile(
    rows: &[MagnetRow],
    facts: &SweepFacts<'_>,
    config: &SweepConfig,
) -> SweepPlan {
    let kind = SweepKind::Reconcile;
    if facts.known_before.is_none() {
        return denied(kind, rows, Reason::InventoryMissing);
    }
    if config.floor > 0 && rows.len() <= config.floor {
        return denied(kind, rows, Reason::Floor);
    }
    let mut plan = SweepPlan::new(kind);
    let mut pass: Vec<&MagnetRow> = Vec::new();
    for row in rows {
        let hash = row.normalized_hash();
        if hash.is_empty() {
            plan.keep_with(key_of(row), Reason::NoHash);
            continue;
        }
        if facts.consulted.contains(&hash) {
            plan.keep_with(hash, Reason::ConsultedThisSearch);
            continue;
        }
        if row.is_active() {
            plan.keep_with(hash, Reason::Active);
            continue;
        }
        if !row.is_ready() {
            plan.keep_with(hash, Reason::NotReady);
            continue;
        }
        if let Some(reason) = protected(facts, &hash, true) {
            plan.keep_with(hash, reason);
            continue;
        }
        let Some(labeled_at) = facts.owned_at.get(&hash).copied() else {
            plan.keep_with(hash, Reason::NoOwnership);
            continue;
        };
        if row.uploaded_at_ms <= 0 {
            plan.keep_with(hash, Reason::NoUploadDate);
            continue;
        }
        // Anti-re-add: upload MAIS NOVO que a etiqueta + margem é re-add do
        // usuário — nunca remove.
        if row.uploaded_at_ms > labeled_at.saturating_add(config.margin()) {
            plan.keep_with(hash, Reason::Readded);
            continue;
        }
        if facts.now_ms.saturating_sub(row.uploaded_at_ms) < config.min_age_ms.max(0) {
            plan.keep_with(hash, Reason::TooYoung);
            continue;
        }
        if row.usable_id().is_none() {
            plan.keep_with(hash, Reason::MissingId);
            continue;
        }
        pass.push(row);
    }
    cap(&mut plan, pass, config.max_per_round);
    plan
}

/// Revalidação da fila de represados (`sup:`) contra o status AUTORITATIVO: o
/// que sumiu da conta cura no chamador (`gone`), o que está terminal e é NOSSO
/// sai. Downloading/`unknown` mantêm o registro.
#[must_use]
pub fn plan_revalidate(
    rows: &[MagnetRow],
    facts: &SweepFacts<'_>,
    config: &SweepConfig,
) -> SweepPlan {
    let kind = SweepKind::Revalidate;
    if facts.known_before.is_none() {
        return denied(kind, rows, Reason::InventoryMissing);
    }
    let mut plan = SweepPlan::new(kind);
    let mut pass: Vec<&MagnetRow> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for row in rows {
        let hash = row.normalized_hash();
        if hash.is_empty() {
            plan.keep_with(key_of(row), Reason::NoHash);
            continue;
        }
        seen.push(hash.clone());
        if !facts.suppressed.contains(&hash) {
            plan.keep_with(hash, Reason::NotSuppressed);
            continue;
        }
        if row.is_active() {
            plan.keep_with(hash, Reason::Active);
            continue;
        }
        if !row.is_dead() {
            plan.keep_with(hash, Reason::NotDead);
            continue;
        }
        if let Some(reason) = protected(facts, &hash, false) {
            plan.keep_with(hash, reason);
            continue;
        }
        let Some(labeled_at) = facts.owned_at.get(&hash).copied() else {
            plan.keep_with(hash, Reason::NoOwnership);
            continue;
        };
        if row.uploaded_at_ms <= 0 {
            plan.keep_with(hash, Reason::NoUploadDate);
            continue;
        }
        if row.uploaded_at_ms > labeled_at.saturating_add(config.margin()) {
            plan.keep_with(hash, Reason::Readded);
            continue;
        }
        if facts.now_ms.saturating_sub(row.uploaded_at_ms) < config.min_age_ms.max(0) {
            plan.keep_with(hash, Reason::TooYoung);
            continue;
        }
        if row.usable_id().is_none() {
            plan.keep_with(hash, Reason::MissingId);
            continue;
        }
        pass.push(row);
    }
    // Represado que não está mais na conta: nada a apagar, o chamador cura.
    for hash in facts.suppressed {
        if !seen.contains(hash) {
            plan.keep_with(hash.clone(), Reason::Gone);
        }
    }
    cap(&mut plan, pass, config.max_per_round);
    plan
}
