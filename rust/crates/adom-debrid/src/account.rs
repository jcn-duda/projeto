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

use serde_json::Value;

use crate::alldebrid::AllDebrid;
use crate::debridlink::DebridLink;
use crate::error::DebridError;
use crate::http::HttpClient;
use crate::realdebrid::RealDebrid;
use crate::torbox::TorBox;
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
    let read = read_items(service, &client, api_key, opts.timeout);
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

async fn read_items(
    service: &str,
    client: &HttpClient,
    api_key: &str,
    timeout: Duration,
) -> Result<Vec<InventoryItem>, DebridError> {
    match service {
        "alldebrid" => alldebrid_items(client, api_key, timeout).await,
        "torbox" => torbox_items(client, api_key, timeout).await,
        "realdebrid" => realdebrid_items(client, api_key).await,
        "debridlink" => debridlink_items(client, api_key).await,
        _ => Ok(Vec::new()),
    }
}

// ── AllDebrid: `/magnet/status` ────────────────────────────────────────────
// Mesmo critério do `account_status`: `ready` OU status Ready (case-insensitive).
async fn alldebrid_items(
    client: &HttpClient,
    api_key: &str,
    timeout: Duration,
) -> Result<Vec<InventoryItem>, DebridError> {
    let adapter = AllDebrid::new(client.clone());
    let data = adapter
        .call(api_key, "/magnet/status", &[], timeout, false)
        .await?;
    let rows = data
        .get("magnets")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut out = Vec::new();
    for magnet in rows {
        let status = magnet.get("status").and_then(Value::as_str).unwrap_or("");
        let ready = js_truthy(magnet.get("ready")) || status.eq_ignore_ascii_case("ready");
        if !ready {
            continue;
        }
        push_item(
            &mut out,
            text_of(magnet.get("hash")),
            text_of(magnet.get("filename")),
            js_number_or_zero(magnet.get("size")),
            None,
        );
    }
    Ok(out)
}

// ── TorBox: `/torrents/mylist` ─────────────────────────────────────────────
// `download_finished || download_present`, o mesmo par do `resolveLink`.
async fn torbox_items(
    client: &HttpClient,
    api_key: &str,
    timeout: Duration,
) -> Result<Vec<InventoryItem>, DebridError> {
    let adapter = TorBox::new(client.clone());
    let list = adapter
        .call(
            api_key,
            "/torrents/mylist",
            reqwest::Method::GET,
            &[],
            None,
            timeout,
        )
        .await?;
    let rows: &[Value] = match list.get("data") {
        Some(Value::Array(rows)) => rows,
        Some(other) if js_truthy(Some(other)) => std::slice::from_ref(other),
        _ => &[],
    };
    let mut out = Vec::new();
    for row in rows {
        if !(js_truthy(row.get("download_finished")) || js_truthy(row.get("download_present"))) {
            continue;
        }
        push_item(
            &mut out,
            text_of(row.get("hash")),
            text_of(row.get("name")),
            js_number_or_zero(row.get("size")),
            None,
        );
    }
    Ok(out)
}

// ── Real-Debrid: `/torrents` paginado ──────────────────────────────────────
// `status === 'downloaded'` (comparação EXATA, como o `READY` do TS). O id
// viaja junto: é o que o play usa para resolver pelo memo sem re-listar.
async fn realdebrid_items(
    client: &HttpClient,
    api_key: &str,
) -> Result<Vec<InventoryItem>, DebridError> {
    let rows = RealDebrid::new(client.clone())
        .list_torrents(api_key)
        .await?;
    let mut out = Vec::new();
    for row in &rows {
        if row.get("status").and_then(Value::as_str) != Some("downloaded") {
            continue;
        }
        push_item(
            &mut out,
            text_of(row.get("hash")),
            text_of(row.get("filename")),
            js_number_or_zero(row.get("bytes")),
            text_of(row.get("id")),
        );
    }
    Ok(out)
}

// ── Debrid-Link: `/seedbox/list` ───────────────────────────────────────────
// O TS compara `Number(row.downloadPercent) < 100`; `undefined` vira NaN e
// `NaN < 100` é FALSO — linha sem percentual NÃO é descartada. Reproduzido.
async fn debridlink_items(
    client: &HttpClient,
    api_key: &str,
) -> Result<Vec<InventoryItem>, DebridError> {
    let list = DebridLink::new(client.clone())
        .call(api_key, "/seedbox/list", reqwest::Method::GET, None, &[])
        .await?;
    let rows = list.as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut out = Vec::new();
    for row in rows {
        if js_number(row.get("downloadPercent")).is_some_and(|percent| percent < 100.0) {
            continue;
        }
        let hash = text_of(row.get("hash")).or_else(|| text_of(row.get("infoHash")));
        // `Number(row.totalSize || row.size) || 0`: valor truthy vence; zero
        // cai no próximo (o `||` do JS).
        let total = js_number_or_zero(row.get("totalSize"));
        let size = if total != 0.0 {
            total
        } else {
            js_number_or_zero(row.get("size"))
        };
        push_item(&mut out, hash, text_of(row.get("name")), size, None);
    }
    Ok(out)
}

/// Mesmo filtro de forma dos adaptadores: hash/título vazios e título que é o
/// próprio hash (magnet sem metadado) ficam de fora.
fn push_item(
    out: &mut Vec<InventoryItem>,
    hash: Option<String>,
    title: Option<String>,
    size: f64,
    id: Option<String>,
) {
    let Some(info_hash) = hash
        .map(|h| h.trim().to_lowercase())
        .filter(|h| !h.is_empty())
    else {
        return;
    };
    let Some(title) = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
    else {
        return;
    };
    if title.to_lowercase() == info_hash {
        return;
    }
    out.push(InventoryItem {
        title,
        info_hash,
        size,
        id,
    });
}

/// `Value` → string não vazia, com trim? O TS faz `String(x || '')` sem trim
/// e aplica `.trim()` só no título. Aqui o trim é do chamador; este helper só
/// evita `null`/`undefined`.
fn text_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// `Number(value) || 0` do JS (inclui string numérica).
fn js_number_or_zero(value: Option<&Value>) -> f64 {
    js_number(value).unwrap_or(0.0)
}

/// `Number(value)`: `None` é o NaN do JS (e o chamador decide).
fn js_number(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Null => return None,
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                0.0
            } else {
                text.parse().ok()?
            }
        }
        _ => return None,
    };
    number.is_finite().then_some(number)
}

/// Truthiness do JS (o `x || y` dos adaptadores).
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

#[cfg(test)]
#[path = "account_tests.rs"]
mod account_tests;
