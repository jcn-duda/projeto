//! Guardas do dreno da represa: o GATE do knob e a retenção viva.
//!
//! Vive fora de `suppressed_step.rs` só pela catraca de 400 linhas — o
//! `pub(crate) use` de lá mantém `suppressed_step::{DrainGate, defended, ...}`
//! como caminho público, então testes e `recheck_expire` não sabem do split.
//!
//! # Gate do knob (o dreno é DESTRUTIVO)
//!
//! O passo APAGA transferência na conta do usuário. O Node só o executa com
//! `config.debrid.removeById` ligado ou com `force` explícito
//! (`src/providers/autofetch-suppressed.ts:280`). Com o knob OFF (o default) o
//! dreno automático é no-op: a represa só cresce, e nada é varrido nem enviado
//! ao serviço. `force` existe SÓ na ação do painel, que é destrutiva e exige
//! confirmação do operador.
//!
//! # Retenção viva
//!
//! `adhold:v1:` (volátil) e `adprot:v1:` (durável do pool BR) barram a remoção
//! em QUALQUER serviço — é o `held.isCleanupProtected(h, account, adapter.id)`
//! do TS; `adrm:v1:` prova que a transferência já saiu.

use adom_index::NativeKv;

/// Motivo publicado quando o gate barrou: `reason`/`gate` da rota e a chave
/// `gate` do `snapshot()`.
pub(crate) const GATE_REMOVE_BY_ID_OFF: &str = "remove-by-id-off";

/// O `if (!config.debrid.removeById && !opts?.force) return 0;` do Node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DrainGate {
    /// `DEBRID_REMOVE_BY_ID` (`.env`, default OFF).
    pub(crate) remove_by_id: bool,
    /// SÓ a ação do painel, já confirmada (`{"confirm":true}` no corpo).
    pub(crate) force: bool,
}

impl DrainGate {
    /// Passo AUTOMÁTICO do laço: respeita o knob e NUNCA força.
    pub(crate) fn automatic(remove_by_id: bool) -> Self {
        Self {
            remove_by_id,
            force: false,
        }
    }

    /// Dreno liberado: knob ligado ou ação confirmada no painel.
    pub(crate) fn open(&self) -> bool {
        self.remove_by_id || self.force
    }
}

/// Retenção viva: hold volátil (`adhold:v1:<conta>:<hash>`) ou proteção durável
/// do pool BR (`adprot:v1:<adapter>:<conta>:<hash>`, T2-L6). `get_json` já
/// responde `None` para o vencido, então registro expirado não defende nada.
/// `adsub:v1:` (posse) NÃO entra: ele autoriza apagar, não impede.
pub(crate) fn defended(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    hash: &str,
    now_ms: i64,
) -> Result<bool, String> {
    let Some((account, hash)) = account_hash(account, hash) else {
        return Ok(false);
    };
    if kv
        .get_json(&format!("adhold:v1:{account}:{hash}"), now_ms)?
        .is_some()
    {
        return Ok(true);
    }
    let adapter = adapter.trim().to_ascii_lowercase();
    Ok(kv
        .get_json(&format!("adprot:v1:{adapter}:{account}:{hash}"), now_ms)?
        .is_some())
}

/// `adrm:v1:` (anti-reenchimento) — remoção já confirmada: nada a apagar na
/// conta, então a entrada sai da represa sem rede.
pub(crate) fn already_removed(
    kv: &NativeKv,
    account: &str,
    hash: &str,
    now_ms: i64,
) -> Result<bool, String> {
    let Some((account, hash)) = account_hash(account, hash) else {
        return Ok(false);
    };
    Ok(kv
        .get_json(&format!("adrm:v1:{account}:{hash}"), now_ms)?
        .is_some())
}

/// `(conta, hash)` normalizados — chave vazia não identifica nada.
fn account_hash(account: &str, hash: &str) -> Option<(String, String)> {
    let account = account.trim().to_ascii_lowercase();
    let hash = hash.trim().to_ascii_lowercase();
    (!account.is_empty() && !hash.is_empty()).then_some((account, hash))
}
