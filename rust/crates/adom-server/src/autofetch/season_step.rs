//! Season Pack Fill (`season_key`) como PASSO do worker nativo do Chupim.
//!
//! Duas metades, como no TS (`autofetch-season-index.ts` +
//! `autofetch-recheck.ts:277-284`):
//!
//! - [`plan`] traduz o efeito `season_key` em [`SeasonStep::Register`]: a busca
//!   por temporada que a abertura de uma série registra `<adapter>:<conta>:
//!   <imdb>:<temporada>` (`SeasonIndex::key`), com os MESMOS tetos do Node
//!   (`DEBRID_AUTO_FETCH_SEASON_INDEX_MAX`/`_KEYS`);
//! - [`plan_fill`] é o outro lado: o pack que ficou pronto invalida as buscas
//!   daquela temporada — e quem decide se o pack PREENCHE o buraco é a régua
//!   pura `season_fill_decision` (`v3::season`), que nunca inventa S1 para um
//!   "Temporada Completa" sem número.
//!
//! # Por que o índice vai para o KV e não para uma `Map` de processo
//!
//! No Node o índice é um `Map` do processo (`autofetch-season-index.ts:8`).
//! Aqui o ESCRITOR (efeito `season_key`, na thread do axum) e o LEITOR (o pack
//! pronto, na thread do worker) são threads diferentes, e o registro não pode
//! se perder num restart no meio do caminho — então a entrada é uma linha do
//! KV nativo (`autofetch:v3:season:<...>`), com a MESMA chave lógica do TS.
//! Nada de texto livre na chave: adapter id, digest da conta, IMDb e número.
//!
//! # Kill-switch
//!
//! Worker pausado (`Control::paused`) ou toggle do fill desligado → `Skip`, sem
//! tocar o KV. O teto de temporadas `0` desliga só o índice, como no TS
//! (`maxSeasons <= 0`), sem derrubar o resto do ciclo.

use adom_autofetch::v3::{
    season_fill_decision, SeasonFill, SeasonFillSkip, SeasonGap, SeasonIndex,
};
use adom_index::NativeKv;
use serde_json::{Map, Value};

/// Prefixo das entradas do índice (`autofetch:v3:season:`).
pub(crate) const SEASON_PREFIX: &str = "autofetch:v3:season:";

/// Réguas do Season Pack Fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SeasonStepConfig {
    /// `DEBRID_AUTO_FETCH_SEASON_FILL` (toggle do preenchimento).
    pub(crate) enabled: bool,
    /// Kill-switch do worker (`Control::paused`).
    pub(crate) paused: bool,
    /// `DEBRID_AUTO_FETCH_SEASON_INDEX_MAX`; `0` desliga o índice.
    pub(crate) max_seasons: usize,
    /// `DEBRID_AUTO_FETCH_SEASON_INDEX_KEYS` (buscas por temporada).
    pub(crate) max_keys: usize,
    /// TTL da entrada no KV (a mesma régua do lote do recheck).
    pub(crate) ttl_seconds: i64,
}

impl SeasonStepConfig {
    /// Réguas do processo — os MESMOS nomes/defaults de `src/config/debrid.ts`.
    /// `ttl_seconds` é a régua do lote do recheck (o índice dura o mesmo).
    pub(crate) fn from_env(paused: bool, ttl_seconds: i64) -> Self {
        Self {
            enabled: env_flag("DEBRID_AUTO_FETCH_SEASON_FILL"),
            paused,
            // `Math.max(0, trunc(num(env, 200)))`; `0` desliga o índice.
            max_seasons: env_num("DEBRID_AUTO_FETCH_SEASON_INDEX_MAX")
                .unwrap_or(200)
                .max(0) as usize,
            // `Math.max(16, trunc(num(env, 256)))`.
            max_keys: env_num("DEBRID_AUTO_FETCH_SEASON_INDEX_KEYS")
                .unwrap_or(256)
                .max(16) as usize,
            ttl_seconds: ttl_seconds.max(1),
        }
    }
}

/// `String(env || 'true') === 'true'` do TS.
fn env_flag(key: &str) -> bool {
    std::env::var(key)
        .map(|raw| raw.trim() == "true")
        .unwrap_or(true)
}

fn env_num(key: &str) -> Option<i64> {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
}

/// Uma busca por temporada a registrar. Sem credencial: `account` é o digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SeasonRegister {
    pub(crate) adapter_id: String,
    pub(crate) account: String,
    pub(crate) imdb_id: String,
    pub(crate) season: i64,
    pub(crate) cache_key: String,
}

impl SeasonRegister {
    /// `seasonIndexKey(adapterId, account, imdbId, season)` do TS.
    pub(crate) fn key(&self) -> String {
        SeasonIndex::key(&self.adapter_id, &self.account, &self.imdb_id, self.season)
    }

    /// Alvo do PREENCHIMENTO: o pack pronto invalida a temporada INTEIRA, então
    /// não existe busca concreta para registrar (`cache_key` vazio). A chave do
    /// KV é a mesma do [`execute`] — `adapter:conta:imdb:temporada`.
    pub(crate) fn target(adapter_id: &str, account: &str, imdb_id: &str, season: i64) -> Self {
        Self {
            adapter_id: adapter_id.to_string(),
            account: account.to_string(),
            imdb_id: imdb_id.to_string(),
            season,
            cache_key: String::new(),
        }
    }

    /// Entrada do KV desta temporada (`SEASON_PREFIX` + chave lógica).
    fn entry_key(&self) -> String {
        index_key(&self.adapter_id, &self.account, &self.imdb_id, self.season)
    }
}

/// Motivo do skip. Os da régua pura vêm de [`SeasonFillSkip`]; pausa e índice
/// desligado são do worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SeasonSkip {
    /// Payload fora de `{adapter_id, account, imdb, season>0, cache_key}`.
    InvalidPayload,
    /// Worker pausado — desliga registro E preenchimento.
    WorkerPaused,
    /// `DEBRID_AUTO_FETCH_SEASON_FILL` off.
    FillDisabled,
    /// `DEBRID_AUTO_FETCH_SEASON_INDEX_MAX=0`: o índice não registra.
    IndexOff,
    /// Régua pura do `v3::season` (só o lado do pack a constrói).
    Rule(SeasonFillSkip),
}

impl SeasonSkip {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPayload => "invalid",
            Self::WorkerPaused => "paused",
            Self::FillDisabled => "fill-off",
            Self::IndexOff => "index-off",
            Self::Rule(SeasonFillSkip::Disabled) => "fill-off",
            Self::Rule(SeasonFillSkip::NotPack) => "not-pack",
            Self::Rule(SeasonFillSkip::NoDeclaredSeason) => "no-declared-season",
            Self::Rule(SeasonFillSkip::UndeclaredSeason) => "undeclared-season",
            Self::Rule(SeasonFillSkip::TitleUnproven) => "title-unproven",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SeasonStep {
    Register(SeasonRegister),
    Skip(SeasonSkip),
}

/// Fatos do release que ficou pronto — o que a régua precisa para decidir.
///
/// Chegam do lote `autofetch_batch`: título do release, temporada DECLARADA pela
/// obra e `is_pack` derivado do título pela mesma régua do TS
/// (`isSeasonPackFillEligible`, `autofetch-runner.ts:66`). O fio que os monta é
/// [`super::season_fill::fill`], chamado pelo laço quando o recheck vê `ready`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SeasonFillFacts<'a> {
    /// Título do release que ficou pronto (`autoFetchRecheck` → hint do lote).
    pub(crate) title: &'a str,
    /// Buraco DECLARADO pela obra (`None` nunca vira S1).
    pub(crate) gap: SeasonGap,
    /// O release é pack de temporada.
    pub(crate) is_pack: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FillStep {
    Fill { season: i64 },
    Skip(SeasonSkip),
}

/// Traduz o efeito `season_key` em registro (ou `Skip`).
pub(crate) fn plan(payload: &Map<String, Value>, config: &SeasonStepConfig) -> SeasonStep {
    let Some(register) = normalize(payload) else {
        return SeasonStep::Skip(SeasonSkip::InvalidPayload);
    };
    if config.paused {
        return SeasonStep::Skip(SeasonSkip::WorkerPaused);
    }
    // Ordem do `registerSeasonSearchKey`: toggle e teto antes de qualquer
    // escrita; com `maxSeasons = 0` não existe índice para preencher.
    if !config.enabled {
        return SeasonStep::Skip(SeasonSkip::FillDisabled);
    }
    if config.max_seasons == 0 {
        return SeasonStep::Skip(SeasonSkip::IndexOff);
    }
    SeasonStep::Register(register)
}

/// Lado do PACK: o release pronto preenche o buraco declarado?
///
/// `Skip` não consome nada no KV: o índice da temporada só é tocado quando a
/// régua responde [`FillStep::Fill`] E a invalidação confirmou.
pub(crate) fn plan_fill(config: &SeasonStepConfig, facts: SeasonFillFacts<'_>) -> FillStep {
    if config.paused {
        return FillStep::Skip(SeasonSkip::WorkerPaused);
    }
    match season_fill_decision(config.enabled, facts.title, facts.gap, facts.is_pack) {
        SeasonFill::Fill { season } => FillStep::Fill { season },
        SeasonFill::Skip(reason) => FillStep::Skip(SeasonSkip::Rule(reason)),
    }
}

/// Payload do efeito → registro. Os guardas são os do `effects::season_key`
/// mais a forma que o `parseEffects` do Node exige.
fn normalize(payload: &Map<String, Value>) -> Option<SeasonRegister> {
    let adapter_id = text(payload, "adapter_id")?;
    let account = text(payload, "account")?;
    if account == "none" {
        return None;
    }
    let imdb_id = text(payload, "imdb")?;
    if !imdb_id.starts_with("tt") || imdb_id.len() < 3 {
        return None;
    }
    let season = payload.get("season")?.as_i64()?;
    if season <= 0 {
        return None;
    }
    let cache_key = text(payload, "cache_key")?;
    Some(SeasonRegister {
        adapter_id: adapter_id.to_string(),
        account: account.to_string(),
        imdb_id: imdb_id.to_string(),
        season,
        cache_key: cache_key.to_string(),
    })
}

fn text<'a>(payload: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Chave do KV da temporada: o prefixo do namespace + a chave lógica do TS.
pub(crate) fn index_key(adapter_id: &str, account: &str, imdb_id: &str, season: i64) -> String {
    format!(
        "{SEASON_PREFIX}{}",
        SeasonIndex::key(adapter_id, account, imdb_id, season)
    )
}

/// Resultado do registro: se a busca entrou e quantas a temporada tem agora.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SeasonIndexReport {
    pub(crate) registered: bool,
    pub(crate) keys: usize,
}

/// Grava a busca da temporada no KV (LRU por temporada e teto por temporada).
///
/// Relê a entrada, reaplica a régua do [`SeasonIndex`] e grava de volta: o
/// índice é do worker, então um `Map` em memória mentiria depois de um restart.
pub(crate) fn execute(
    kv: &NativeKv,
    register: &SeasonRegister,
    config: &SeasonStepConfig,
    now_ms: i64,
) -> Result<SeasonIndexReport, String> {
    let key = register.entry_key();
    let existing = read_keys(kv, &key, now_ms)?;
    let mut index = SeasonIndex::new();
    // Uma temporada por entrada: o LRU de temporadas do `SeasonIndex` é
    // preservado pelo TTL do KV, não por um vetor de 200 temporadas em RAM.
    for known in &existing {
        index.register(
            true,
            &register.adapter_id,
            &register.account,
            &register.imdb_id,
            register.season,
            known,
            1,
            config.max_keys,
        );
    }
    let registered = index.register(
        config.enabled,
        &register.adapter_id,
        &register.account,
        &register.imdb_id,
        register.season,
        &register.cache_key,
        1,
        config.max_keys,
    );
    if !registered {
        return Ok(SeasonIndexReport {
            registered: false,
            keys: existing.len(),
        });
    }
    let keys = index
        .keys_of(&register.key())
        .map(<[String]>::to_vec)
        .unwrap_or_default();
    write_keys(kv, &key, &keys, config.ttl_seconds, now_ms)?;
    Ok(SeasonIndexReport {
        registered: true,
        keys: keys.len(),
    })
}

/// Buscas registradas da temporada, SEM consumir a entrada.
///
/// É o primeiro tempo do preenchimento ([`super::season_fill::fill`]): ler antes
/// de apagar permite que uma falha na invalidação do cache de streams deixe o
/// índice INTACTO para a passagem seguinte. Consumir primeiro transformaria
/// erro de I/O em perda silenciosa do registro.
pub(crate) fn peek(
    kv: &NativeKv,
    register: &SeasonRegister,
    now_ms: i64,
) -> Result<Vec<String>, String> {
    read_keys(kv, &register.entry_key(), now_ms)
}

/// Invalidação do pack pronto: devolve as buscas registradas e apaga a entrada.
///
/// Segundo tempo de [`super::season_fill::fill`]: só depois de o cache de
/// streams confirmar a remoção das buscas (ver [`peek`]).
pub(crate) fn take(
    kv: &NativeKv,
    register: &SeasonRegister,
    now_ms: i64,
) -> Result<Vec<String>, String> {
    let key = register.entry_key();
    let keys = read_keys(kv, &key, now_ms)?;
    kv.forget(&key)?;
    Ok(keys)
}

fn read_keys(kv: &NativeKv, key: &str, now_ms: i64) -> Result<Vec<String>, String> {
    let Some(value) = kv.get_json(key, now_ms)? else {
        return Ok(Vec::new());
    };
    match value {
        Value::Array(items) => Ok(items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect()),
        // Forma inesperada é entrada vazia, não erro: o índice é descartável.
        _ => {
            eprintln!("[autofetch] índice de temporada ilegível em {key}");
            Ok(Vec::new())
        }
    }
}

fn write_keys(
    kv: &NativeKv,
    key: &str,
    keys: &[String],
    ttl_seconds: i64,
    now_ms: i64,
) -> Result<(), String> {
    if keys.is_empty() {
        kv.forget(key)?;
        return Ok(());
    }
    let value = serde_json::to_value(keys).map_err(|err| err.to_string())?;
    kv.put_json(key, &value, ttl_seconds.max(1), now_ms)
}

#[cfg(test)]
#[path = "season_step_tests.rs"]
mod tests;
