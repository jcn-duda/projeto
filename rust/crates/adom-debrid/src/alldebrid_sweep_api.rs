//! Leitura do inventário AllDebrid para as varreduras; arquivos são buscados
//! sob demanda por id para o gateway selecionar candidatos primeiro.

use serde_json::Value;

use super::{AllDebrid, CALL_TIMEOUT};
use crate::error::DebridError;

#[derive(Debug, Clone, PartialEq)]
pub struct SweepMagnet {
    pub id: String,
    pub hash: String,
    pub status: String,
    pub ready: bool,
    pub filename: String,
    pub upload_date_ms: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SweepFile {
    pub path: String,
    pub size: f64,
}

impl AllDebrid {
    /// Lê a lista da conta numa única chamada. `uploadDate` chega em segundos.
    /// Corpo 200/success SEM `magnets` — ou do qual QUALQUER linha não rendeu
    /// id/hash — é FALHA, nunca lista (parcial): a varredura poda `adprot` e
    /// cura a fila `sup:` com base nesta leitura, e foto truncada não prova
    /// ausência (mesmo contrato de [`Self::magnet_index`]).
    pub async fn sweep_magnet_list(&self, api_key: &str) -> Result<Vec<SweepMagnet>, DebridError> {
        let data = self
            .call(api_key, "/magnet/status", &[], CALL_TIMEOUT, false)
            .await?;
        parse_listing(magnets_array(&data)?)
    }

    /// Lista a conta para a evicção por hash (`hash -> id`).
    ///
    /// Corpo sem `magnets` — ou com QUALQUER linha sem id/hash — é **falha** e
    /// não lista parcial: quem apaga por hash não pode concluir nada a partir
    /// de uma leitura que não aconteceu por inteiro.
    pub async fn magnet_index(&self, api_key: &str) -> Result<Vec<SweepMagnet>, DebridError> {
        let data = self
            .call(api_key, "/magnet/status", &[], CALL_TIMEOUT, false)
            .await?;
        parse_listing(magnets_array(&data)?)
    }

    /// Lê a árvore de UM magnet pronto. O chamador escolhe os ids a consultar;
    /// magnet ausente, não pronto ou sem `files` devolve lista vazia.
    pub async fn sweep_magnet_files(
        &self,
        api_key: &str,
        id: &str,
    ) -> Result<Vec<SweepFile>, DebridError> {
        let data = self
            .call(
                api_key,
                "/magnet/status",
                &[("id", id)],
                CALL_TIMEOUT,
                false,
            )
            .await?;
        let Some(magnet) = first_magnet(&data) else {
            return Ok(Vec::new());
        };
        if !magnet
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status.eq_ignore_ascii_case("ready"))
        {
            return Ok(Vec::new());
        }
        let Some(nodes) = magnet.get("files").and_then(Value::as_array) else {
            return Ok(Vec::new());
        };
        let mut files = Vec::new();
        flatten_files(nodes, "", &mut files);
        Ok(files)
    }
}

fn parse_magnet(row: &Value) -> Option<SweepMagnet> {
    let id = match row.get("id")? {
        Value::String(value) if !value.is_empty() => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => return None,
    };
    let hash = row
        .get("hash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    if hash.is_empty() {
        return None;
    }
    let status = string_value(row.get("status"));
    let ready = row.get("ready").and_then(Value::as_bool) == Some(true)
        || status.eq_ignore_ascii_case("ready");
    Some(SweepMagnet {
        id,
        hash,
        status,
        ready,
        filename: string_value(row.get("filename")),
        upload_date_ms: numeric_value(row.get("uploadDate")) * 1000.0,
    })
}

fn string_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(boolean)) => boolean.to_string(),
        _ => String::new(),
    }
}

fn numeric_value(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => text.parse::<f64>().unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    }
}

fn first_magnet(data: &Value) -> Option<&Value> {
    match data.get("magnets")? {
        Value::Array(rows) => rows.first(),
        Value::Object(_) => data.get("magnets"),
        _ => None,
    }
}

/// A lista de magnets do payload: ausente ou fora de forma é FALHA (`Err`),
/// não `Ok(vazio)` — uma leitura que não aconteceu não prova conta vazia.
fn magnets_array(data: &Value) -> Result<&[Value], DebridError> {
    data.get("magnets")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| DebridError::other("alldebrid: /magnet/status sem lista de magnets"))
}

/// Linhas reconhecidas. QUALQUER linha não reconhecida (id/hash ausentes) é
/// FALHA — inclusive quando outras linhas renderam: uma listagem parcialmente
/// malformada pode ser foto truncada da conta, e ausência fundada nela podaria
/// o `adprot` (poda) e curaria a fila `sup:` de magnet ainda presente.
fn parse_listing(rows: &[Value]) -> Result<Vec<SweepMagnet>, DebridError> {
    let parsed: Vec<SweepMagnet> = rows.iter().filter_map(parse_magnet).collect();
    if parsed.len() != rows.len() {
        return Err(DebridError::other(
            "alldebrid: listagem parcialmente malformada (id/hash ausentes em parte das linhas)",
        ));
    }
    Ok(parsed)
}

fn flatten_files(nodes: &[Value], prefix: &str, files: &mut Vec<SweepFile>) {
    for node in nodes {
        let name = node.get("n").and_then(Value::as_str).unwrap_or("");
        let path = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        if let Some(children) = node.get("e").and_then(Value::as_array) {
            flatten_files(children, &path, files);
        } else if node
            .get("l")
            .and_then(Value::as_str)
            .is_some_and(|link| !link.is_empty())
        {
            files.push(SweepFile {
                path,
                size: node.get("s").and_then(Value::as_f64).unwrap_or(0.0),
            });
        }
    }
}

#[cfg(test)]
#[path = "alldebrid_sweep_api_tests.rs"]
mod tests;
