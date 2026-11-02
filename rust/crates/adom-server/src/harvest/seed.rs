//! Semente de populares do IMDb (RapidAPI) — porte de `src/providers/imdb-seed.ts`.
//!
//! As listas `most-popular-movies` e `most-popular-tv` viram fila do colhedor
//! ANTES de alguém pedir. Só entra id `tt…` JÁ LANÇADO e com público
//! (`numVotes`); obra já indexada não é re-enfileirada (a semente descobre, não
//! renova). A coorte (`seed:v1:cohort`) guarda o top de cada tipo para o
//! baseline de cobertura BR (F3).
//!
//! Invariantes (as do TS, mantidas):
//! 1. A chave da RapidAPI vem do `.env` e NUNCA vai a log ou a erro: o erro de
//!    rede sai sem URL (`without_url`) e a resposta não-2xx só leva o status.
//! 2. Sem chave, ou com `RELEASE_INDEX` desligado, ou com a semente off
//!    (`.env` ou painel): zero requisição.
//! 3. A marca `seed:v1:last` é gravada ANTES da rede. API fora do ar não vira
//!    retry a cada minuto: o ciclo seguinte só roda depois do cooldown.
//! 4. Lista que falha preserva o balde anterior da coorte, e a coorte só é
//!    regravada se ao menos uma lista respondeu — a baseline não regride por
//!    uma tremedeira de rede.
//!
//! O ciclo é um laço próprio numa thread `adom-seed` (runtime `current_thread`),
//! como o colhedor: o `Result` de cada tick é logado e nada derruba o gateway.

use std::time::Duration;

use adom_harvest::{HarvestMediaType, HarvestRequest};
use adom_search::orchestrator::{ReleaseIndexSource, SharedIndex};
use adom_store::NativeKv;
use serde_json::{json, Value};

use super::live::LIVE_KEY;
use super::HarvestHandle;
use regra::{data_utc, ids_aprovados, js_num_texto, ler_coorte, Cohort, Escolha, Pick, COHORT_KEY};

#[path = "seed_regra.rs"]
mod regra;

/// Marca do cooldown (`seed:v1:last`): valor = instante do ciclo.
const MARCA_KEY: &str = "seed:v1:last";
/// Intervalo do laço. O primeiro tick sai só depois de um intervalo inteiro.
const TICK: Duration = Duration::from_secs(60);
/// Motivo gravado na fila (o mesmo do TS).
const REASON: &str = "popular";
/// Listas consultadas em TODO ciclo, nesta ordem (filmes antes de séries).
const LISTAS: [(&str, HarvestMediaType); 2] = [
    ("most-popular-movies", HarvestMediaType::Movie),
    ("most-popular-tv", HarvestMediaType::Series),
];

/// Configuração efetiva do ciclo: `.env` (default) + overrides do painel.
pub(crate) struct SeedSettings {
    /// `SEED_ENABLED`, ou o `seedEnabled` do painel quando houver.
    pub(crate) enabled: bool,
    /// `RELEASE_INDEX` (sem índice não há como saber o que já está indexado).
    pub(crate) release_index: bool,
    /// `RAPIDAPI_KEY`. Nunca logada, nunca em erro.
    pub(crate) api_key: String,
    /// `RAPIDAPI_IMDB_HOST` (default `imdb236.p.rapidapi.com`).
    pub(crate) host: String,
    /// Raiz das URLs: `https://{host}` em produção; o teste aponta ao servidor local.
    pub(crate) base: String,
    /// `SEED_MAX_PER_CYCLE`: teto de obras enfileiradas por ciclo.
    pub(crate) max_per_cycle: usize,
    /// `SEED_MIN_VOTES`: piso de público.
    pub(crate) min_votes: f64,
    /// `SEED_INTERVAL_H`: cooldown entre ciclos (horas, mínimo 1).
    pub(crate) interval_h: u64,
    /// `SEED_TIMEOUT_MS`: prazo de cada lista.
    pub(crate) timeout: Duration,
    /// `F3_BR_TOP_PER_TYPE` (1..100): quantos ids por tipo entram na coorte.
    pub(crate) top_per_type: usize,
}

/// Overrides do painel (`cfg:v1:harvester`) já tipados; `None` = vale o `.env`.
#[derive(Default)]
pub(crate) struct SeedLive {
    enabled: Option<bool>,
    max_per_cycle: Option<usize>,
    min_votes: Option<f64>,
    interval_h: Option<u64>,
}

impl SeedSettings {
    /// Lê o `.env` com as mesmas regras do `config/harvest.ts` (default, clamp).
    pub(crate) fn from_env() -> Self {
        let host = env_texto("RAPIDAPI_IMDB_HOST", "imdb236.p.rapidapi.com");
        Self {
            enabled: env_flag("SEED_ENABLED"),
            release_index: env_flag("RELEASE_INDEX"),
            api_key: std::env::var("RAPIDAPI_KEY").unwrap_or_default(),
            base: format!("https://{host}"),
            host,
            max_per_cycle: env_num("SEED_MAX_PER_CYCLE", 20.0).trunc().max(0.0) as usize,
            min_votes: env_num("SEED_MIN_VOTES", 1000.0).trunc().max(0.0),
            interval_h: env_num("SEED_INTERVAL_H", 24.0).trunc().max(1.0) as u64,
            timeout: Duration::from_millis(env_num("SEED_TIMEOUT_MS", 8000.0).max(1.0) as u64),
            top_per_type: env_num("F3_BR_TOP_PER_TYPE", 100.0)
                .trunc()
                .clamp(1.0, 100.0) as usize,
        }
    }

    /// Aplica o painel por cima do `.env`, com os mesmos clamps do schema TS.
    pub(crate) fn com_painel(mut self, live: &SeedLive) -> Self {
        if let Some(enabled) = live.enabled {
            self.enabled = enabled;
        }
        if let Some(max) = live.max_per_cycle {
            self.max_per_cycle = max;
        }
        if let Some(votes) = live.min_votes {
            self.min_votes = votes;
        }
        if let Some(hours) = live.interval_h {
            self.interval_h = hours;
        }
        self
    }

    /// Chave presente e índice ligado: só então o ciclo pode tocar a rede.
    fn ativa_no_ambiente(&self) -> bool {
        !self.api_key.is_empty() && self.release_index
    }
}

impl SeedLive {
    /// Objeto do `cfg:v1:harvester`. Campo ilegível vira ausente.
    pub(crate) fn from_value(value: &Value) -> Self {
        let num = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
        };
        Self {
            enabled: value.get("seedEnabled").and_then(Value::as_bool),
            max_per_cycle: num("seedMaxPerCycle").map(|n| n.trunc().clamp(1.0, 100.0) as usize),
            min_votes: num("seedMinVotes").map(|n| n.trunc().clamp(0.0, 100_000.0)),
            interval_h: num("seedIntervalH").map(|n| n.trunc().clamp(1.0, 168.0) as u64),
        }
    }
}

/// `GET /api/imdb/{caminho}` com os headers da RapidAPI. Erro sem URL e sem chave.
async fn buscar_lista(
    cliente: &reqwest::Client,
    s: &SeedSettings,
    caminho: &str,
) -> Result<Vec<Value>, String> {
    let url = format!("{}/api/imdb/{caminho}", s.base);
    let resposta = cliente
        .get(&url)
        .timeout(s.timeout)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("x-rapidapi-host", &s.host)
        .header("x-rapidapi-key", &s.api_key)
        .send()
        .await
        .map_err(|err| format!("rede: {}", err.without_url()))?;
    let status = resposta.status();
    if !status.is_success() {
        return Err(format!("http_{}", status.as_u16()));
    }
    // `Response::json` exige a feature `json` do reqwest, que o crate não liga.
    let texto = resposta
        .text()
        .await
        .map_err(|err| format!("corpo: {}", err.without_url()))?;
    let corpo: Value = serde_json::from_str(&texto).map_err(|_| "json invalido".to_string())?;
    Ok(match corpo {
        Value::Array(itens) => itens,
        _ => Vec::new(),
    })
}

/// Um ciclo: decide, consulta as DUAS listas e grava a coorte. Devolve as
/// escolhas para o chamador enfileirar. Erro só quando a marca não coube no KV
/// (sem ela o ciclo não pode rodar, senão a API seria consultada a cada tick).
pub(crate) async fn ciclo(
    s: &SeedSettings,
    kv: &NativeKv,
    index: Option<&dyn ReleaseIndexSource>,
    now: i64,
) -> Result<Vec<Pick>, String> {
    if !(s.enabled && s.ativa_no_ambiente()) {
        return Ok(Vec::new());
    }
    if kv.get_json(MARCA_KEY, now)?.is_some() {
        return Ok(Vec::new());
    }
    let ttl_h = s.interval_h.max(1) as i64;
    kv.put_json(MARCA_KEY, &json!(now), ttl_h * 3600, now)?;

    let hoje = data_utc(now);
    let previa = ler_coorte(kv, now, s.top_per_type).ok().flatten();
    let mut coorte = Cohort {
        at: now,
        movies: previa
            .as_ref()
            .map(|c| c.movies.clone())
            .unwrap_or_default(),
        series: previa.map(|c| c.series).unwrap_or_default(),
    };
    let conhecida = |id: &str| index.is_some_and(|ix| !ix.lookup(id, None, None, now).is_empty());
    let cliente = reqwest::Client::builder()
        .build()
        .map_err(|err| format!("cliente http: {err}"))?;

    let mut escolha = Escolha::default();
    let mut alguma_respondeu = false;
    for (caminho, tipo) in LISTAS {
        let itens = match buscar_lista(&cliente, s, caminho).await {
            Ok(itens) => itens,
            Err(err) => {
                // O balde anterior daquele tipo fica intacto na coorte.
                eprintln!("[seed] lista {caminho} falhou: {err}");
                continue;
            }
        };
        alguma_respondeu = true;
        let aprovados = ids_aprovados(&itens, &hoje, s.min_votes, s.top_per_type, tipo);
        match tipo {
            HarvestMediaType::Movie => coorte.movies = aprovados,
            HarvestMediaType::Series => coorte.series = aprovados,
        }
        escolha.absorver(&itens, tipo, s, &hoje, &conhecida);
    }

    if alguma_respondeu {
        // Mesmo relógio do ciclo (marca, leitura e TTL da coorte no mesmo `now`).
        coorte.at = now;
        let ttl = (ttl_h * 3) * 3600;
        if let Err(err) = kv.put_json(COHORT_KEY, &coorte.to_json(), ttl, now) {
            eprintln!("[seed] falha ao persistir coorte: {err}");
        }
    }
    if !escolha.picks.is_empty() {
        eprintln!(
            "[seed] {} obra(s) popular(es) nova(s) para o colhedor ({} avaliadas, {} já no índice)",
            escolha.picks.len(),
            escolha.vistos,
            escolha.conhecidas
        );
    }
    Ok(escolha.picks)
}

/// Pedido de fila do candidato: série sem temporada, como no TS.
fn pedido(pick: &Pick) -> HarvestRequest {
    HarvestRequest {
        imdb_id: pick.imdb_id.clone(),
        media_type: pick.media,
        season: None,
        episode: None,
        reason: REASON.to_string(),
        br_probe: false,
    }
}

/// Sobe a thread `adom-seed`. Sem chave, o laço roda mas não toca a rede.
pub(crate) fn spawn(handle: HarvestHandle, index: Option<SharedIndex>) {
    let thread = std::thread::Builder::new()
        .name("adom-seed".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    eprintln!("[seed] runtime da thread não montou: {err}");
                    return;
                }
            };
            runtime.block_on(serve(handle, index));
        });
    if let Err(err) = thread {
        eprintln!("[seed] thread não subiu: {err}");
    }
}

async fn serve(handle: HarvestHandle, index: Option<SharedIndex>) {
    let mut kv: Option<NativeKv> = None;
    loop {
        tokio::time::sleep(TICK).await;
        if let Err(err) = tick(&handle, index.as_deref(), &mut kv).await {
            eprintln!("[seed] ciclo falhou: {err}");
        }
    }
}

/// Um tick do laço: config viva, ciclo e enfileiramento das escolhas.
async fn tick(
    handle: &HarvestHandle,
    index: Option<&dyn ReleaseIndexSource>,
    kv: &mut Option<NativeKv>,
) -> Result<(), String> {
    let ambiente = SeedSettings::from_env();
    // Sem chave ou sem índice, nem abre o KV: o módulo é inerte.
    if !ambiente.ativa_no_ambiente() {
        return Ok(());
    }
    if kv.is_none() {
        *kv = Some(NativeKv::open(&adom_store::default_cache_db_path())?);
    }
    let Some(kv) = kv.as_ref() else {
        return Ok(());
    };
    let now = adom_sources::now_ms();
    let live = match kv.get_json(LIVE_KEY, now) {
        Ok(Some(valor)) => SeedLive::from_value(&valor),
        _ => SeedLive::default(),
    };
    let settings = ambiente.com_painel(&live);
    for pick in ciclo(&settings, kv, index, now).await? {
        handle.enqueue(pedido(&pick)).await;
    }
    Ok(())
}

/// Texto do ambiente: vazio cai no default, como o `||` do TS.
fn env_texto(key: &str, default: &str) -> String {
    match std::env::var(key) {
        Ok(raw) if !raw.is_empty() => raw,
        _ => default.to_string(),
    }
}

/// `String(process.env.X || 'true') === 'true'`.
fn env_flag(key: &str) -> bool {
    match std::env::var(key) {
        Ok(raw) if !raw.is_empty() => raw == "true",
        _ => true,
    }
}

/// `num(process.env.X, default)`: `Number(valor)` finito, senão o default.
fn env_num(key: &str, default: f64) -> f64 {
    match std::env::var(key) {
        Ok(raw) => {
            let n = js_num_texto(&raw);
            if n.is_finite() {
                n
            } else {
                default
            }
        }
        Err(_) => default,
    }
}

#[cfg(test)]
#[path = "seed_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "seed_net_tests.rs"]
mod net_tests;
