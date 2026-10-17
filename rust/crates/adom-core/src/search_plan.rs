//! Porte de `src/providers/search-plan.ts`: o PLANO da coleta do Jackett.
//!
//! Quem estoura o orçamento de coleta não pode compartilhar Promise: um
//! NerdFilmes de 7,4s segurava o BLUDV (e um redetorrent de 20s segurava o
//! TPB) fora do balde até depois dos ~6,5s. Globais de teto curto continuam
//! agrupados — cabem no prazo. `ptBrIndexers` só decide a query em pt-BR.
//!
//! # Semântica JS que o golden cobre
//!
//! - `ptQuery || query`: string VAZIA também cai para `query` (falsy), não só
//!   `null`/`undefined`.
//! - A task agrupada só nasce com `grouped.length > 0`; a task de varredura só
//!   quando `sweepQuery && sweepQuery !== query`.
//! - Ordem: agrupada, varredura agrupada, depois as isoladas NA ORDEM de
//!   `selectedIndexers`.
//! - Presença CONDICIONAL de propriedade no objeto JS (`variant`, `fallback`,
//!   `franchise`, `original`, `multiWork`, `sweep`) vira `Option` com
//!   `skip_serializing_if`: o `deepEqual` do Node distingue "ausente" de
//!   `null`.
//!
//! `numeral_search_variant` (`search_name_helpers`), `franchise_root` e
//! `ends_with_sequence_marker` (`release_name_matching`) são REUSADOS — a regra
//! não é reescrita aqui.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::js_text::js_trim;
use crate::matching_vocabulary::JS_SPACE;
use crate::release_name_matching::{ends_with_sequence_marker, franchise_root};
use crate::search_name_helpers::numeral_search_variant;

/// Uma tarefa do plano da coleta (espelha o objeto do TS).
///
/// `sweep` é `true` quando presente (marca ESTRUTURAL da varredura pt-BR dos
/// globais); no TS a propriedade só existe nesse caso, então aqui é `Option`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPlanTask {
    pub query: String,
    pub indexers: Vec<String>,
    /// Grafia arábica da sequência (só no indexer BR).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// Query original como fallback (só BR+ptQuery diferente).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    /// Raiz da franquia, degrau após o título sem ano (só BR com sequência).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub franchise: Option<String>,
    /// Título original da obra (TMDB), degrau de último recurso.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
    /// Raiz da coleção multiobra (TMDB), degrau SEQUENCIAL só no indexer BR.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_work: Option<String>,
    /// Marca ESTRUTURAL da task de varredura pt-BR agrupada.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sweep: Option<bool>,
}

/// `/\s+(?:19|20)\d{2}\s*$/` — o ano do FIM da query.
///
/// `\s` é o conjunto do JS (`JS_SPACE`) e `\z` é o `$` sem multiline (o regex
/// crate não trata `\n` final como fim, como o JS).
fn trailing_year_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(r"{s}+(?:19|20)[0-9]{{2}}{s}*\z", s = JS_SPACE))
            .expect("regex do ano final compila")
    })
}

/// `task.query.replace(/\s+(?:19|20)\d{2}\s*$/, '').trim()`.
fn strip_trailing_year(query: &str) -> String {
    js_trim(trailing_year_re().replace(query, "").as_ref()).to_string()
}

/// `planJackettQueries`: separa os indexers lentos/BR em tarefas isoladas e
/// mantém os globais agrupados, com a varredura como task extra.
///
/// A query pt-BR só vai para o indexer BR; a variante numérica, o fallback
/// original e os degraus de franquia/multiobra nascem APENAS no ramo BR.
// 8 parâmetros: espelha 1:1 o contrato do TS (os cinco últimos têm default lá).
// Agrupar num struct mudaria a assinatura portada e a ordem dos degraus.
#[allow(clippy::too_many_arguments)]
pub fn plan_jackett_queries(
    query: &str,
    pt_query: Option<&str>,
    selected_indexers: &[String],
    pt_br_indexers: &[String],
    isolate_indexers: &[String],
    sweep_query: Option<&str>,
    original_query: Option<&str>,
    multi_work_query: Option<&str>,
) -> Vec<SearchPlanTask> {
    let br_set: HashSet<&str> = pt_br_indexers.iter().map(String::as_str).collect();
    let isolate_set: HashSet<&str> = pt_br_indexers
        .iter()
        .chain(isolate_indexers)
        .map(String::as_str)
        .collect();
    // `ptQuery || query`: vazio é falsy, igual a null/undefined.
    let pt = pt_query.filter(|s| !s.is_empty());
    let sweep = sweep_query.filter(|s| !s.is_empty());
    let original = original_query.filter(|s| !s.is_empty());
    let multi_work = multi_work_query.filter(|s| !s.is_empty());

    let mut grouped: Vec<String> = Vec::new();
    let mut isolated: Vec<SearchPlanTask> = Vec::new();

    for indexer in selected_indexers {
        if isolate_set.contains(indexer.as_str()) {
            let is_br = br_set.contains(indexer.as_str());
            let mut task = SearchPlanTask {
                query: if is_br {
                    pt.unwrap_or(query).to_string()
                } else {
                    query.to_string()
                },
                indexers: vec![indexer.clone()],
                ..SearchPlanTask::default()
            };
            if is_br {
                // Grafia arábica do numeral de sequência (II -> 2): a query que
                // sai pro indexer BR é pt-BR (ou a original sem ptQuery) e pode
                // carregar o numeral em romano.
                if let Some(variant) = numeral_search_variant(&task.query) {
                    task.variant = Some(variant);
                }
                // BR com título diferente carrega o original EN como fallback
                // SEQUENCIAL do mesmo indexer.
                if pt.is_some() && pt != Some(query) {
                    task.fallback = Some(query.to_string());
                }
                // Raiz da franquia como degrau SEQUENCIAL (nunca tarefa própria):
                // o WordPress BR não acha o post da coleção com o marcador no
                // fim — "Se Beber, Não Case! Parte II" devolve 0 onde "Se Beber,
                // Não Case!" acha a Trilogia. O corte só vale quando veio de
                // marcador de sequência no fim: subtítulo só (": O Devoto") e
                // filme sem sequência ficam sem degrau.
                let bare = strip_trailing_year(&task.query);
                let franchise = franchise_root(&bare);
                if !franchise.is_empty() && franchise != bare && ends_with_sequence_marker(&bare) {
                    task.franchise = Some(franchise);
                }
                // Raiz da coleção multiobra (TMDB): degrau SEQUENCIAL SÓ no
                // indexer BR — o dublado raro mora na coleção publicada por
                // site BR e a query do filme isolado nunca acha. Global não
                // recebe: a franquia multiobra é artefato da listagem BR (e o
                // pack global iria P2P).
                if let Some(multi_work) = multi_work {
                    task.multi_work = Some(multi_work.to_string());
                }
            }
            // O original é degrau de último recurso em AMBOS os caminhos; quem
            // NÃO o executa (BR com fallback pt-BR ativo) decide no
            // `queryIndexer`, que conhece o contexto de cada indexer.
            if let Some(original) = original {
                task.original = Some(original.to_string());
            }
            isolated.push(task);
        } else {
            grouped.push(indexer.clone());
        }
    }

    let mut plan: Vec<SearchPlanTask> = Vec::new();
    if !grouped.is_empty() {
        let mut main = SearchPlanTask {
            query: query.to_string(),
            indexers: grouped.clone(),
            ..SearchPlanTask::default()
        };
        // Globais não têm caminho pt-BR próprio: o título original ("Adım
        // Farah") é o que trackers como o magnetdownload publicam e a query em
        // inglês ("My Name Is Farah") nunca encontra.
        if let Some(original) = original {
            main.original = Some(original.to_string());
        }
        plan.push(main);
        // `sweepQuery && sweepQuery !== query`: a task só existe quando muda.
        if let Some(sweep) = sweep {
            if sweep != query {
                plan.push(SearchPlanTask {
                    query: sweep.to_string(),
                    indexers: grouped,
                    sweep: Some(true),
                    ..SearchPlanTask::default()
                });
            }
        }
    }
    plan.extend(isolated);
    plan
}

/// Alvos da varredura TARDIA com o título pt-BR: os selecionados que NÃO são
/// BR. Os BR já recebem o título localizado no caminho crítico (e com
/// strip/bare-title pensados para buscador WordPress, que não se aplicam aos
/// globais); tracker global é quem hospeda dublado titulado em português que a
/// query em inglês não acha.
///
/// Index-only também saem: eles já são consultados INDIVIDUALMENTE pela fila do
/// colhedor, com orçamento dedicado — varrê-los aqui seria uma segunda porta
/// pela qual a latência deles escapa.
pub fn pt_sweep_indexers(
    selected_indexers: &[String],
    pt_br_indexers: &[String],
    index_only_indexers: &[String],
) -> Vec<String> {
    let br_set: HashSet<&str> = pt_br_indexers.iter().map(String::as_str).collect();
    let fora: HashSet<&str> = index_only_indexers.iter().map(String::as_str).collect();
    selected_indexers
        .iter()
        .filter(|i| !br_set.contains(i.as_str()) && !fora.contains(i.as_str()))
        .cloned()
        .collect()
}

/// Indexers que só alimentam o índice pelo colhedor NÃO entram no plano ao
/// vivo: latência de 8–31s contra orçamento total de 20s derrubava-os no
/// breaker a cada busca e ainda queimava o prazo com o retry PT→título
/// original. A busca ao vivo serve do índice (`idxPoolCovered` decide); quem
/// mantém as releases deles frescas é o colhedor, cujas falhas não contam no
/// breaker nem pintam card. Lista vazia = comportamento antigo.
///
/// Exceções de presença (`exempt`): indexers que continuam index-only para o
/// resto do sistema, mas cuja busca cabe no orçamento ao vivo. O 1337x é o caso
/// global: busca fria de 12,2–19s e redirect /dl/ de 1,8–6,5s contra orçamento
/// de 4s.
pub fn live_indexers(
    selected_indexers: &[String],
    index_only_indexers: &[String],
    exempt_indexers: &[String],
) -> Vec<String> {
    let fora: HashSet<&str> = index_only_indexers.iter().map(String::as_str).collect();
    let isentos: HashSet<&str> = exempt_indexers.iter().map(String::as_str).collect();
    selected_indexers
        .iter()
        .filter(|i| !fora.contains(i.as_str()) || isentos.contains(i.as_str()))
        .cloned()
        .collect()
}

/// Query da varredura: título pt SEM subtítulo e SEM ano, pela mesma raiz da
/// franquia do inventário da conta (`franchiseRoot`) — duplicar a regra faria
/// os dois caminhos divergirem. Buscador global casa por palavras: "Jornada nas
/// Estrelas: O Filme 1979" devolve 1 resultado, "Jornada nas Estrelas" devolve
/// 13 em três. A precisão continua do `matchContext`, que roda depois.
pub fn pt_sweep_query(title_pt: Option<&str>) -> String {
    franchise_root(title_pt.unwrap_or(""))
}

/// Query da varredura pt-BR. O gate "tem pt localizado e ele difere do
/// original" é o que evita varrer TODO filme ("Joker", "Missão: Impossível" sem
/// subtítulo em português) e disparar uma segunda rodada inútil nos globais.
///
/// A comparação é ESTRITA (`titles.pt === titles.original`), sem
/// normalização.
pub fn pt_sweep_query_for(
    titles_pt: Option<&str>,
    titles_original: Option<&str>,
) -> Option<String> {
    let pt = titles_pt.filter(|s| !s.is_empty())?;
    if Some(pt) == titles_original {
        return None;
    }
    let root = pt_sweep_query(Some(pt));
    if root.is_empty() {
        None
    } else {
        Some(root)
    }
}

/// `comparable`: caixa baixa, NFD, fora as marcas U+0300–U+036F e tudo que não
/// é `[a-z0-9]` vira espaço, com trim. NÃO usa `strip_diacritics` de propósito:
/// o fold de letras (ß→ss, Ł→L) mudaria a comparação, e o TS não o faz.
fn comparable(s: &str) -> String {
    let lowered = s.to_lowercase();
    let folded: String = lowered
        .nfd()
        .filter(|&c| !matches!(c, '\u{0300}'..='\u{036f}'))
        .collect();
    let mut out = String::with_capacity(folded.len());
    let mut pending_space = false;
    for c in folded.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(c);
        } else {
            pending_space = true;
        }
    }
    out
}

/// Variante "<título> dublado" para quando o pt é IGUAL ao original
/// ("Apocalypse Now"): aí a varredura pt não existe (`pt_sweep_query_for` →
/// None) e o tracker global, que pagina (LimeTorrents devolve 12), enterra o
/// dublado atrás das edições gringas. Medido em 15 filmes assim (2026-09-24): 2
/// dublados reais e tocáveis só apareciam com ela (Apocalypse Now 720p
/// AndreTPF, 30 seeders; Deadpool e Wolverine 720p WEB-DL). SÓ o colhedor usa —
/// p90 de 4,4s por consulta e o kickass passa pelo FlareSolverr serial.
pub fn dubbed_sweep_query_for(
    titles_pt: Option<&str>,
    titles_en: Option<&str>,
    titles_original: Option<&str>,
) -> Option<String> {
    let pt = titles_pt.filter(|s| !s.is_empty())?;
    let original = titles_en
        .filter(|s| !s.is_empty())
        .or_else(|| titles_original.filter(|s| !s.is_empty()))?;
    if comparable(pt) != comparable(original) {
        return None;
    }
    let root = pt_sweep_query(Some(pt));
    if root.is_empty() {
        None
    } else {
        Some(format!("{root} dublado"))
    }
}
