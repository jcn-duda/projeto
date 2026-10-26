//! Limpeza e invalidação do namespace `streams:v21` (extraído de `streams.rs`
//! para a catraca de 400 linhas).
//!
//! Toda limpeza anda a geração (T1-C1) na MESMA transação do `DELETE`: uma
//! busca que capturou a geração anterior não consegue gravar a lista velha
//! depois — nem entre o `DELETE` e o commit.

use rusqlite::params;

use crate::streams::{is_imdb_id, streams_prefix, StreamsStore};

impl StreamsStore {
    pub fn forget(&self, key: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Apaga TODO o namespace (`clear-cache` do painel). Devolve quantas linhas
    /// saíram — é o número que o Node relata ao operador.
    pub fn clear_all(&self) -> Result<usize, String> {
        let conn = self.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        let removed = tx
            .execute(
                "DELETE FROM cache WHERE substr(key, 1, length(?1)) = ?1",
                params![streams_prefix()],
            )
            .map_err(|err| err.to_string())?;
        crate::streams_fence::bump_epoch(&tx)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(removed)
    }

    /// Apaga as chaves de UMA obra no formato
    /// `<prefixo><movie|series>:<tt…>:<scope>` — o espelho de
    /// `invalidateStreamsForObra` do Node (`src/utils/br-gap.ts`). O token
    /// `tt\d+` é o primeiro segmento depois do tipo, então `:tt1230` não colide
    /// com `:tt123`.
    pub fn invalidate_for_obra(&self, imdb_id: &str) -> Result<usize, String> {
        let target = imdb_id.trim().to_ascii_lowercase();
        if !is_imdb_id(&target) {
            return Err(format!("imdbId inválido: {imdb_id}"));
        }
        let conn = self.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        // A geração anda ANTES do select: a chave pode nem existir ainda (é a
        // busca em voo que vai criá-la) e é essa escrita que precisa perder a
        // corrida. Mesma transação, então não há janela entre andar e apagar.
        crate::streams_fence::bump_obra(&tx, &target)?;
        let prefix = streams_prefix();
        let keys: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT key FROM cache WHERE substr(key, 1, length(?1)) = ?1")
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(params![prefix], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?;
            rows.filter_map(Result::ok)
                .filter(|key| obra_id_of(key).is_some_and(|id| id == target))
                .collect()
        };
        let mut removed = 0;
        for key in &keys {
            removed += tx
                .execute("DELETE FROM cache WHERE key = ?1", params![key])
                .map_err(|err| err.to_string())?;
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(removed)
    }

    /// Apaga as chaves cuja ENTRADA menciona o hash. Serve ao `/resolve`: o
    /// item resolvido perde `infoHash` (a URL relativa de `/resolve/<hash>` é o
    /// que sobra), então a varredura é textual no valor, em minúsculas (hex).
    pub fn invalidate_for_hash(&self, hash: &str) -> Result<usize, String> {
        let target = hash.trim().to_ascii_lowercase();
        if target.len() != 40 || !target.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("hash inválido: {hash}"));
        }
        let conn = self.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        let removed = tx
            .execute(
                "DELETE FROM cache WHERE substr(key, 1, length(?1)) = ?1
             AND instr(lower(value), ?2) > 0",
                params![streams_prefix(), target],
            )
            .map_err(|err| err.to_string())?;
        crate::streams_fence::bump_epoch(&tx)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(removed)
    }

    /// Apaga as chaves que terminam no sufixo (escopo “instalação” do painel:
    /// `:<streamsCacheScope>`). Sufixo vazio = limpar tudo.
    pub fn clear_by_suffix(&self, suffix: &str) -> Result<usize, String> {
        if suffix.is_empty() {
            return self.clear_all();
        }
        let conn = self.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        let removed = tx
            .execute(
                "DELETE FROM cache WHERE substr(key, 1, length(?1)) = ?1
             AND substr(key, -length(?2)) = ?2",
                params![streams_prefix(), suffix],
            )
            .map_err(|err| err.to_string())?;
        crate::streams_fence::bump_epoch(&tx)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(removed)
    }
}

/// Obra (imdbId) de uma chave `streams:v21:<movie|series>:<tt…>:…`.
/// `None` = chave fora do formato (não é deste filtro).
fn obra_id_of(key: &str) -> Option<&str> {
    let rest = key.strip_prefix(streams_prefix())?;
    let (kind, after) = rest.split_once(':')?;
    if kind != "movie" && kind != "series" {
        return None;
    }
    let id = after.split(':').next()?;
    is_imdb_id(id).then_some(id)
}
