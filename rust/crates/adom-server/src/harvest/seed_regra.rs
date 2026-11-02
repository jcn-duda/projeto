//! Régua pura da semente de populares (porte do `imdb-seed.ts`): filtros de
//! obra aproveitável, dedupe e teto das listas, validação da coorte do KV,
//! escolha dos candidatos e data UTC do ciclo. Sem rede e sem relógio próprio:
//! tudo que depende de tempo recebe `now`/`hoje` por parâmetro.

use adom_harvest::HarvestMediaType;
use adom_store::NativeKv;
use serde_json::{json, Value};

use super::SeedSettings;

/// Coorte popular persistida (`seed:v1:cohort`): `{"at","movies","series"}`.
pub(super) const COHORT_KEY: &str = "seed:v1:cohort";

/// Um candidato escolhido neste ciclo (o chamador o enfileira).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Pick {
    pub(crate) imdb_id: String,
    pub(crate) media: HarvestMediaType,
}

/// Coorte popular persistida. Só ids e instante — nunca credencial.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Cohort {
    pub(crate) at: i64,
    pub(crate) movies: Vec<String>,
    pub(crate) series: Vec<String>,
}

impl Cohort {
    pub(crate) fn to_json(&self) -> Value {
        json!({ "at": self.at, "movies": self.movies, "series": self.series })
    }
}

/// `Number(x || 0)` do JS: falsy vira 0, string passa pelo parse, o resto é NaN.
/// NaN não rejeita em `< minVotes` (a comparação é falsa), como no TS.
pub(super) fn js_num(valor: Option<&Value>) -> f64 {
    match valor {
        None | Some(Value::Null) | Some(Value::Bool(false)) => 0.0,
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_num_texto(s),
        Some(_) => f64::NAN,
    }
}

/// `String(x || '')` do JS para os campos que a semente lê (id, tipo, data).
/// Objeto/array viram vazio: nenhum deles é válido nesses campos.
pub(super) fn js_texto(valor: Option<&Value>) -> String {
    match valor {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) if n.as_f64().unwrap_or(0.0) != 0.0 => n.to_string(),
        Some(Value::Bool(true)) => "true".to_string(),
        _ => String::new(),
    }
}

pub(super) fn js_num_texto(texto: &str) -> f64 {
    let limpo = texto.trim();
    if limpo.is_empty() {
        return 0.0;
    }
    limpo.parse::<f64>().unwrap_or(f64::NAN)
}

/// `^tt\d+$`.
pub(super) fn e_imdb_tt(id: &str) -> bool {
    id.strip_prefix("tt")
        .is_some_and(|digitos| !digitos.is_empty() && digitos.bytes().all(|b| b.is_ascii_digit()))
}

/// `TIPOS`: `tvMovie` conta como filme e `tvMiniSeries` como série.
pub(super) fn tipo_para_media(tipo: &str) -> Option<HarvestMediaType> {
    match tipo {
        "movie" | "tvMovie" => Some(HarvestMediaType::Movie),
        "tvSeries" | "tvMiniSeries" => Some(HarvestMediaType::Series),
        _ => None,
    }
}

/// Já lançada, com público real e id utilizável. `hoje` é `AAAA-MM-DD` (UTC).
pub(super) fn aproveitavel(item: &Value, hoje: &str, min_votes: f64) -> bool {
    if !e_imdb_tt(&js_texto(item.get("id"))) {
        return false;
    }
    if tipo_para_media(&js_texto(item.get("type"))).is_none() {
        return false;
    }
    if js_num(item.get("numVotes")) < min_votes {
        return false;
    }
    let lancamento = js_texto(item.get("releaseDate"));
    if lancamento.is_empty() {
        // Sem data, o ano serve de aproximação grosseira: melhor um limítrofe
        // do que descartar obra antiga por metadado ausente.
        let ano = js_num(item.get("startYear"));
        let ano_hoje = hoje
            .get(..4)
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(f64::NAN);
        return ano > 0.0 && ano <= ano_hoje;
    }
    lancamento.as_str() <= hoje
}

/// Filtra e deduplica os ids aproveitáveis de uma lista, na ordem da API.
pub(super) fn ids_aprovados(
    itens: &[Value],
    hoje: &str,
    min_votes: f64,
    topo: usize,
    tipo: HarvestMediaType,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in itens {
        if out.len() >= topo {
            break;
        }
        if !aproveitavel(item, hoje, min_votes) {
            continue;
        }
        if tipo_para_media(&js_texto(item.get("type"))) != Some(tipo) {
            continue;
        }
        let id = js_texto(item.get("id"));
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Valida o shape de uma lista de ids vinda do KV: só `tt…`, sem duplicata.
pub(super) fn sanitize_ids(lista: Option<&Value>, topo: usize) -> Vec<String> {
    let Some(itens) = lista.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for valor in itens {
        let id = js_texto(Some(valor));
        if !e_imdb_tt(&id) || out.contains(&id) {
            continue;
        }
        out.push(id);
        if out.len() >= topo {
            break;
        }
    }
    out
}

/// A coorte gravada, ou `None` quando não há instante válido nem id utilizável.
pub(super) fn ler_coorte(kv: &NativeKv, now: i64, topo: usize) -> Result<Option<Cohort>, String> {
    let Some(raw) = kv.get_json(COHORT_KEY, now)? else {
        return Ok(None);
    };
    let at = raw
        .get("at")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map(|n| n as i64);
    let Some(at) = at else {
        return Ok(None);
    };
    let movies = sanitize_ids(raw.get("movies"), topo);
    let series = sanitize_ids(raw.get("series"), topo);
    if movies.is_empty() && series.is_empty() {
        return Ok(None);
    }
    Ok(Some(Cohort { at, movies, series }))
}

/// Acúmulo do laço de escolha (o `escolhidas`/`vistos`/`conhecidas` do TS).
#[derive(Default)]
pub(crate) struct Escolha {
    pub(crate) picks: Vec<Pick>,
    pub(crate) vistos: usize,
    pub(crate) conhecidas: usize,
}

impl Escolha {
    /// Percorre uma lista na ordem da API. O teto corta ANTES de contar o item,
    /// igual ao `break` do TS. `conhecida` diz se a obra já está no índice.
    pub(crate) fn absorver(
        &mut self,
        itens: &[Value],
        tipo: HarvestMediaType,
        s: &SeedSettings,
        hoje: &str,
        conhecida: &dyn Fn(&str) -> bool,
    ) {
        for item in itens {
            if self.picks.len() >= s.max_per_cycle {
                break;
            }
            self.vistos += 1;
            if !aproveitavel(item, hoje, s.min_votes) {
                continue;
            }
            if tipo_para_media(&js_texto(item.get("type"))) != Some(tipo) {
                continue;
            }
            let id = js_texto(item.get("id"));
            if conhecida(&id) {
                self.conhecidas += 1;
                continue;
            }
            self.picks.push(Pick {
                imdb_id: id,
                media: tipo,
            });
        }
    }
}

/// Data UTC `AAAA-MM-DD` de um instante em ms (`toISOString().slice(0, 10)`).
pub(crate) fn data_utc(now_ms: i64) -> String {
    // Algoritmo de dias-civis (Howard Hinnant), sem dependência de calendário.
    let z = now_ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dia = doy - (153 * mp + 2) / 5 + 1;
    let mes = if mp < 10 { mp + 3 } else { mp - 9 };
    let ano = yoe + era * 400 + i64::from(mes <= 2);
    format!("{ano:04}-{mes:02}-{dia:02}")
}
