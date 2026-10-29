//! IMPORT do NDJSON de export e BACKFILL de `dubbed`/`quality` do banco de
//! magnets. Porte de `importLines` (`src/utils/magnet-bank-transfer.ts`) e de
//! `backfillClassification` (`src/utils/magnet-bank-backfill.ts`).
//!
//! O import MESCLA, nunca substitui (decisão do operador, 2026-09-29): nada que
//! já existe localmente é apagado, e importar o mesmo arquivo duas vezes não
//! muda o banco na segunda. O cabeçalho `{"t":"meta","format":…,"v":1}` é
//! obrigatório: é ele que recusa arquivo de outro formato ou versão, antes de
//! gravar qualquer coisa.
//!
//! Um lote de magnets = uma transação (200, o tamanho do TS). Lote grande segura
//! o mutex do store e a busca ao vivo espera junto; por isso o mutex é tomado
//! por lote, e não para o arquivo inteiro. Quem chama deve rodar isto fora do
//! executor assíncrono (`spawn_blocking`): aqui não há event loop a devolver a
//! vez, como o `setImmediate` do TS.
//!
//! O backfill cobre o acervo gravado antes da captura classificar pelo título
//! (182 mil magnets saíram com as duas colunas vazias). É idempotente sem
//! marcador: o alvo é `quality = ''`, e toda linha tocada ganha qualidade não
//! vazia (no mínimo "sem resolução"), então a segunda passada não faz nada.

use std::io::BufRead;

use adom_core::quality_from_title;
use rusqlite::{params, Connection};
use serde_json::Value;

use super::capture::classified_dubbed;
use super::MagnetBankStore;

#[path = "magnet_bank_import_rows.rs"]
mod rows;
#[path = "magnet_bank_import_sql.rs"]
mod sql;

use rows::{js_text, read_magnet, read_source, read_work, BankMagnet, BankSource, BankWork};

const TRANSFER_FORMAT: &str = "adom-magnet-bank";
const TRANSFER_VERSION: f64 = 1.0;
/// Magnets por transação do import (ver o cabeçalho do módulo).
const IMPORT_BATCH: usize = 200;

/// Contadores de um tipo de registro (`read` = válidos lidos do arquivo).
#[derive(Debug, Clone, Default, serde::Serialize, PartialEq, Eq)]
pub struct ImportCounter {
    pub read: u64,
    pub inserted: u64,
    pub merged: u64,
}

/// Resultado do import. `ok:false` com `error` é arquivo RECUSADO (não é falha
/// de I/O): a resposta é válida e o banco ficou intacto.
#[derive(Debug, Clone, Default, serde::Serialize, PartialEq, Eq)]
pub struct ImportReport {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub lines: u64,
    pub rejected: u64,
    pub magnets: ImportCounter,
    pub sources: ImportCounter,
    pub works: ImportCounter,
}

/// Registros válidos ainda não gravados. Esvazia a cada lote de magnets.
#[derive(Default)]
struct Batch {
    magnets: Vec<BankMagnet>,
    sources: Vec<BankSource>,
    works: Vec<BankWork>,
}

impl MagnetBankStore {
    /// Mescla o NDJSON no banco (regra do TS). Erro de leitura ou de SQLite vira
    /// `Err`; arquivo recusado vira `Ok` com `ok:false` e `error`.
    pub fn import_ndjson<R: BufRead>(&self, reader: R) -> Result<ImportReport, String> {
        let mut report = ImportReport::default();
        let mut header = false;
        let mut batch = Batch::default();
        for line in reader.lines() {
            let line = line.map_err(|err| format!("ler o arquivo do import: {err}"))?;
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            report.lines += 1;
            let value: Value = match serde_json::from_str(line) {
                Ok(value) => value,
                // Antes do cabeçalho, linha que não é JSON é o arquivo errado
                // inteiro; depois dele é só um registro ruim.
                Err(_) if !header => {
                    return Ok(refused(report, "arquivo não é NDJSON do banco de magnets"))
                }
                Err(_) => {
                    report.rejected += 1;
                    continue;
                }
            };
            if !header {
                if let Some(error) = header_error(&value) {
                    return Ok(refused(report, &error));
                }
                header = true;
                continue;
            }
            match value.get("t").and_then(Value::as_str) {
                Some("m") => match read_magnet(&value) {
                    Some(row) => {
                        report.magnets.read += 1;
                        batch.magnets.push(row);
                    }
                    None => report.rejected += 1,
                },
                Some("s") => match read_source(&value) {
                    Some(row) => {
                        report.sources.read += 1;
                        batch.sources.push(row);
                    }
                    None => report.rejected += 1,
                },
                Some("w") => match read_work(&value) {
                    Some(row) => {
                        report.works.read += 1;
                        batch.works.push(row);
                    }
                    None => report.rejected += 1,
                },
                _ => report.rejected += 1,
            }
            // O corte do lote conta só magnets, como no TS: fonte e obra
            // seguem o magnet a que pertencem no próprio arquivo.
            if batch.magnets.len() >= IMPORT_BATCH {
                self.flush_locked(std::mem::take(&mut batch), &mut report)?;
            }
        }
        if !header {
            return Ok(refused(report, "arquivo vazio"));
        }
        self.flush_locked(batch, &mut report)?;
        report.ok = true;
        Ok(report)
    }

    /// Preenche `dubbed`/`quality` das linhas com `quality = ''`. Devolve quantas
    /// linhas foram atualizadas. `batch` é o tamanho de cada transação.
    pub fn backfill_classification(&self, batch: usize) -> Result<u64, String> {
        let batch = batch.max(1) as i64;
        self.lock()
            .execute_batch(
                "CREATE INDEX IF NOT EXISTS magnet_quality_pending ON magnet (quality) \
                 WHERE quality = ''",
            )
            .map_err(|err| format!("índice do backfill: {err}"))?;
        let mut last_rowid: i64 = 0;
        let mut updated: u64 = 0;
        loop {
            // Mutex por lote: a busca ao vivo entra entre os lotes.
            let mut conn = self.lock();
            let pending = select_pending(&conn, last_rowid, batch)
                .map_err(|err| format!("ler pendentes do backfill: {err}"))?;
            if pending.is_empty() {
                break;
            }
            let tx = conn
                .transaction()
                .map_err(|err| format!("abrir lote do backfill: {err}"))?;
            for (rowid, hash, title, is_br, dubbed) in pending {
                last_rowid = rowid;
                // `dubbed` só sobe: nunca apaga uma marca que já existia.
                let dubbed = i64::from(dubbed != 0 || classified_dubbed(&title, is_br != 0));
                tx.execute(
                    "UPDATE magnet SET dubbed = ?1, quality = ?2 WHERE hash = ?3",
                    params![dubbed, quality_from_title(&title), hash],
                )
                .map_err(|err| format!("gravar o backfill: {err}"))?;
                updated += 1;
            }
            tx.commit()
                .map_err(|err| format!("fechar lote do backfill: {err}"))?;
        }
        Ok(updated)
    }

    /// Grava um lote tomando o mutex só por ele.
    fn flush_locked(&self, batch: Batch, report: &mut ImportReport) -> Result<(), String> {
        let mut conn = self.lock();
        sql::flush(&mut conn, batch, report)
    }
}

type Pending = (i64, String, String, i64, i64);

/// Próximo lote de linhas sem classificação, pelo rowid (cursor, não OFFSET).
fn select_pending(conn: &Connection, after: i64, limit: i64) -> rusqlite::Result<Vec<Pending>> {
    let mut stmt = conn.prepare(
        "SELECT rowid, hash, title, is_br, dubbed FROM magnet \
         WHERE quality = '' AND rowid > ?1 ORDER BY rowid LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![after, limit], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;
    rows.collect()
}

fn refused(report: ImportReport, error: &str) -> ImportReport {
    ImportReport {
        ok: false,
        error: Some(error.to_string()),
        ..report
    }
}

/// Mensagem de recusa do cabeçalho, ou `None` quando o arquivo é do formato
/// e da versão certos. A versão compara com igualdade ESTRITA, como o TS: `"1"`
/// não é `1`.
fn header_error(value: &Value) -> Option<String> {
    let is_header = value.get("t").and_then(Value::as_str) == Some("meta")
        && value.get("format").and_then(Value::as_str) == Some(TRANSFER_FORMAT);
    if !is_header {
        return Some("cabeçalho ausente: o arquivo não é um export do banco de magnets".into());
    }
    let version = value.get("v");
    let is_version = matches!(version, Some(Value::Number(n)) if n.as_f64() == Some(TRANSFER_VERSION));
    if !is_version {
        return Some(format!(
            "versão do arquivo não suportada ({})",
            js_text(version)
        ));
    }
    None
}
