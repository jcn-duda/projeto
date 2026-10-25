//! As escritas que o recorder usa (o `CrawlRecorderDeps` do TS) e a
//! implementação de produção sobre os dois bancos do Adom.
//!
//! O trait existe para o teste injetar falha de fila/barreira sem tocar no SQL;
//! a produção usa o [`NativeStore`] (`magnets.db` + `cache.db` `idx:v14`).

use adom_core::{BankRow, WorkTarget};
use adom_search::RawItem;
use adom_store::{
    IndexedRelease, MagnetBankStore, RecordOptions as IndexRecordOptions, ReleaseIndexStore,
    WorkCtx,
};
use serde_json::Value;

/// As escritas que o recorder usa (o `CrawlRecorderDeps` do TS).
pub trait IngestStore: Send + Sync {
    /// `captureAndMarkFilter` atômico: captura o lote no banco vivo e marca
    /// `passed_filter` na MESMA locação. `Ok(false)` = fila cheia (nada entrou).
    fn capture_and_mark(
        &self,
        entered: &[RawItem],
        survivors: &[RawItem],
        source: &str,
        ctx: &WorkCtx,
        now_ms: i64,
    ) -> Result<bool, String>;

    /// `flushBarrier`: `false` = o lote não efetivou (a página não avança).
    fn flush(&self) -> bool;

    /// `lookupQuiet`: foto do índice na locação (episódio → temporada → raiz).
    fn lookup(&self, imdb: &str, location: WorkTarget, now_ms: i64) -> Vec<IndexedRelease>;

    fn is_partial(&self, imdb: &str, location: WorkTarget, now_ms: i64) -> bool;

    /// `releaseIndex.record`: devolve quantos hashes NOVOS ficaram no índice.
    fn record(
        &self,
        imdb: &str,
        location: WorkTarget,
        items: &[Value],
        opts: IndexRecordOptions<'_>,
        now_ms: i64,
    ) -> Result<usize, String>;
}

/// Implementação de produção: `magnets.db` + `cache.db` (`idx:v14`) do Adom.
#[derive(Clone)]
pub struct NativeStore {
    bank: std::sync::Arc<MagnetBankStore>,
    index: std::sync::Arc<ReleaseIndexStore>,
}

impl NativeStore {
    pub fn new(bank: MagnetBankStore, index: ReleaseIndexStore) -> Self {
        Self {
            bank: std::sync::Arc::new(bank),
            index: std::sync::Arc::new(index),
        }
    }

    pub fn from_arcs(
        bank: std::sync::Arc<MagnetBankStore>,
        index: std::sync::Arc<ReleaseIndexStore>,
    ) -> Self {
        Self { bank, index }
    }

    /// Abre os dois bancos pelos caminhos do operador (`MAGNET_BANK_DB_PATH`,
    /// `CACHE_DB_PATH`). O chamador decide se o banco vivo está ligado
    /// (`MAGNET_BANK`) antes de montar a ingestão.
    pub fn from_env() -> Result<Self, String> {
        Ok(Self::new(
            MagnetBankStore::from_env()?,
            ReleaseIndexStore::from_env()?,
        ))
    }

    pub fn bank(&self) -> std::sync::Arc<MagnetBankStore> {
        self.bank.clone()
    }

    pub fn index(&self) -> std::sync::Arc<ReleaseIndexStore> {
        self.index.clone()
    }
}

impl IngestStore for NativeStore {
    fn capture_and_mark(
        &self,
        entered: &[RawItem],
        survivors: &[RawItem],
        source: &str,
        ctx: &WorkCtx,
        now_ms: i64,
    ) -> Result<bool, String> {
        // A captura é UMA transação: ou o lote inteiro entra, ou nada entra.
        self.bank.capture_items(entered, source, ctx, now_ms)?;
        let entered: Vec<Value> = entered.iter().map(RawItem::to_wire).collect();
        let survivors: Vec<Value> = survivors.iter().map(RawItem::to_wire).collect();
        // A marca do filtro falhar NÃO é "fila cheia": a captura já commitou.
        // Devolver `false` aqui faria o chamador mentir ("nada entrou"), então
        // a falha sobe como erro de store.
        if !self
            .bank
            .mark_filter_outcome(&entered, &survivors, ctx, now_ms)
        {
            return Err("mark_filter_outcome do banco vivo falhou".to_string());
        }
        Ok(true)
    }

    /// O banco nativo grava a captura na própria chamada (transação já
    /// commitada); não há fila para drenar. O método fica na costura para a
    /// fiação que trocar o store por uma fila e para o teste injetar falha.
    fn flush(&self) -> bool {
        true
    }

    fn lookup(&self, imdb: &str, location: WorkTarget, now_ms: i64) -> Vec<IndexedRelease> {
        self.index.lookup(imdb, location, now_ms)
    }

    fn is_partial(&self, imdb: &str, location: WorkTarget, now_ms: i64) -> bool {
        self.index.is_partial(imdb, location, now_ms)
    }

    fn record(
        &self,
        imdb: &str,
        location: WorkTarget,
        items: &[Value],
        opts: IndexRecordOptions<'_>,
        now_ms: i64,
    ) -> Result<usize, String> {
        // `mediaSource` das linhas sem `dn=`: o índice não conhece o banco vivo,
        // então a leitura entra por closure (como o `bankLookup` do Node).
        let bank = |hashes: &[String]| {
            self.bank
                .bank_rows_many(hashes)
                .unwrap_or_else(|_| Vec::new())
        };
        self.index.record(
            imdb,
            location,
            items,
            opts,
            self.index.ttl(),
            self.index.max_releases(),
            now_ms,
            Some(&bank as &dyn Fn(&[String]) -> Vec<BankRow>),
        )
    }
}
