//! Repetição de um hash entre obras, a evidência do corte de magnet alheio.
//!
//! Conta só a aprovação (`passed_filter = 1`): o hash aparece em centenas de
//! obras como resultado rejeitado de busca, e isso não diz nada sobre ele. A
//! própria obra fica de fora, para o veredito não depender da marca dela. O
//! prefixo `hash` da chave primária atende a consulta.

use std::collections::BTreeMap;

use super::MagnetBankStore;

/// Teto de parâmetros por consulta do SQLite é 32766; o lote da busca é bem menor.
const CHUNK: usize = 500;

impl MagnetBankStore {
    pub fn other_works_passed(
        &self,
        hashes: &[String],
        imdb: &str,
    ) -> Result<BTreeMap<String, i64>, String> {
        let conn = self.lock();
        let mut out = BTreeMap::new();
        for chunk in hashes.chunks(CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT hash, COUNT(DISTINCT imdb) FROM magnet_work \
                 WHERE hash IN ({placeholders}) AND passed_filter = 1 AND imdb <> ? \
                 GROUP BY hash"
            );
            let mut stmt = conn.prepare_cached(&sql).map_err(|err| err.to_string())?;
            let params = chunk.iter().map(String::as_str).chain([imdb]);
            let rows = stmt
                .query_map(rusqlite::params_from_iter(params), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(|err| err.to_string())?;
            for row in rows {
                let (hash, works) = row.map_err(|err| err.to_string())?;
                out.insert(hash, works);
            }
        }
        Ok(out)
    }
}
