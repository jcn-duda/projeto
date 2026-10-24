//! Inventário PRONTO da conta do debrid como FONTE da busca (F3).
//!
//! Porte fiel do `inventory()` de cada adaptador TS
//! (`src/debrid/*-inventory`/`alldebrid-api.ts`/`torbox.ts`/`realdebrid.ts`/
//! `debridlink.ts`): só o que já está pronto na conta vira item, com o MESMO
//! filtro de "pronto" e as MESMAS rejeições (título vazio, título que é o
//! próprio hash). A deduplicação/memo/efeitos continuam FORA daqui: esta
//! camada só lê e classifica.
//!
//! Contrato de retorno ([`AccountInventory`]):
//!
//! - **`known:true`** — o serviço respondeu (lista vazia é resposta, não
//!   "nada em cache");
//! - **`known:false`** — não deu para saber (rede, prazo, rate limit): NUNCA
//!   vira "vazio", pelo mesmo motivo do `checkCached`;
//! - **`unusable`** — só `auth`/`quota`, os dois motivos que o núcleo trata
//!   como conta fora do ar. A lista volta como P2P e o fast-path da conta não
//!   dispara; rede/limite NÃO são `unusable`.
//!
//! Serviço conhecido SEM inventário (Premiumize, como no TS) devolve um
//! resultado vazio e `known:true` — a feature é no-op para ele. Serviço
//! DESCONHECIDO devolve `Err` para o chamador cair na reserva Node.
//!
//! Sem log de chave, título ou corpo. Nada é gravado: memo, davail e banco de
//! magnets continuam no chamador (o Node segue dono desses efeitos).

use std::time::Duration;

use crate::error::DebridError;
use crate::http::HttpClient;
use crate::verdict::UnusableKind;

/// Teto defensivo de itens lidos da conta (o Node usa `DEBRID_INVENTORY_MAX=3000`).
pub const DEFAULT_MAX: usize = 3000;
/// Teto da leitura como fonte (`DEBRID_INVENTORY_TIMEOUT_MS=1500` no Node).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(1_500);

/// Serviço fora do despacho do inventário (`unknown_service`).
pub const UNKNOWN_SERVICE: &str = "unknown_service";

/// Um item pronto da conta, na mesma forma do `InventoryItem` do TS.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct InventoryItem {
    pub title: String,
    /// Sempre em lower-case (o TS faz `.toLowerCase()`).
    pub info_hash: String,
    /// `Number(...) || 0` do TS.
    pub size: f64,
    /// Id do torrent na conta (o RD usa no play): preservado, nunca no título.
    pub id: Option<String>,
}

/// Veredito da leitura do inventário.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AccountInventory {
    pub items: Vec<InventoryItem>,
    /// `false` = não deu para saber (rede/prazo/rate limit).
    pub known: bool,
    /// `auth`/`quota` com a mensagem do serviço.
    pub unusable: Option<(UnusableKind, String)>,
}

impl AccountInventory {
    /// Conta fora do ar: a lista volta P2P e o fast-path não dispara.
    pub fn is_unusable(&self) -> bool {
        self.unusable.is_some()
    }
}

/// Limites da leitura (o chamador lê a config do processo).
#[derive(Debug, Clone, Copy)]
pub struct InventoryOpts {
    pub timeout: Duration,
    pub max: usize,
}

impl Default for InventoryOpts {
    fn default() -> Self {
        InventoryOpts {
            timeout: DEFAULT_TIMEOUT,
            max: DEFAULT_MAX,
        }
    }
}

/// Serviço conhecido pelo despacho de debrid (mesma lista do `verdict`).
pub fn is_known_service(service: &str) -> bool {
    matches!(
        service,
        "premiumize" | "realdebrid" | "alldebrid" | "torbox" | "debridlink"
    )
}

/// O serviço tem inventário? Premiumize não tem (o TS também não expõe), então
/// a feature é no-op para ele.
pub fn supports_inventory(service: &str) -> bool {
    matches!(
        service,
        "alldebrid" | "torbox" | "realdebrid" | "debridlink"
    )
}

/// Rótulo de exibição do adaptador (mesmo `label` do registry TS). É o
/// `tracker` que o item de conta carrega na lista.
pub fn label_of(service: &str) -> &'static str {
    match service {
        "premiumize" => "Premiumize",
        "realdebrid" => "Real-Debrid",
        "alldebrid" => "AllDebrid",
        "torbox" => "TorBox",
        "debridlink" => "Debrid-Link",
        _ => "debrid",
    }
}

/// Lê o inventário PRONTO da conta. `Err` só para serviço desconhecido — os
/// demais desfechos são veredito (`known`/`unusable`), nunca erro de rede.
pub async fn fetch_inventory(
    service: &str,
    api_key: &str,
    opts: InventoryOpts,
) -> Result<AccountInventory, String> {
    if !is_known_service(service) {
        return Err(UNKNOWN_SERVICE.to_string());
    }
    if !supports_inventory(service) {
        // Sem inventário: resposta vazia e KNOWN (no-op), não "não sei".
        return Ok(AccountInventory {
            known: true,
            ..AccountInventory::default()
        });
    }
    let Some(client) = HttpClient::new().ok() else {
        // Sem cliente HTTP não há leitura; honestamente "não sei".
        return Ok(AccountInventory::default());
    };
    let read = sources::read_items(service, &client, api_key, opts.timeout);
    let items = match tokio::time::timeout(opts.timeout, read).await {
        Ok(Ok(items)) => items,
        // Rede/prazo: "não sei", nunca "vazio".
        Ok(Err(err)) => return Ok(failure(err)),
        Err(_) => return Ok(AccountInventory::default()),
    };
    let mut items = items;
    items.truncate(opts.max.max(1));
    Ok(AccountInventory {
        items,
        known: true,
        unusable: None,
    })
}

/// Erro do serviço → veredito. Só auth/quota são `unusable`.
fn failure(err: DebridError) -> AccountInventory {
    let (mut kind, mut message) = match &err {
        DebridError::Auth(message) => (Some(UnusableKind::Auth), message.clone()),
        DebridError::Quota(message) => (Some(UnusableKind::Quota), message.clone()),
        _ => (None, err.message().to_string()),
    };
    // Debrid-Link (e qualquer adaptador que devolva `Other` cru) não classifica
    // a mensagem: o inventário aplica a MESMA taxonomia do `common.ts` para
    // não perder auth/quota. Só `Other` é reclassificado — `Blocked`/rate limit
    // continuam "não sei", como no `verdict`.
    if kind.is_none() && matches!(err, DebridError::Other(_)) {
        match crate::error::classify_message(err.message()) {
            DebridError::Auth(text) => {
                kind = Some(UnusableKind::Auth);
                message = text;
            }
            DebridError::Quota(text) => {
                kind = Some(UnusableKind::Quota);
                message = text;
            }
            _ => {}
        }
    }
    AccountInventory {
        items: Vec::new(),
        known: false,
        unusable: kind.map(|kind| (kind, message)),
    }
}

#[path = "account_sources.rs"]
mod sources;

#[cfg(test)]
#[path = "account_tests.rs"]
mod account_tests;
