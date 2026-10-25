//! Identificação segura da obra de uma página raspada — porte de
//! `src/providers/crawl-identify.ts`.
//!
//! A Fase 1 da raspagem só grava IMDb quando a ficha técnica ANCORAVA um `tt`
//! único; toda a cauda de páginas sem âncora — a maioria — passa por aqui:
//! título + ano que o site publica → obra única no TMDB → IMDb id.
//!
//! A preferência é de SEGURANÇA e não é negociável: obra errada é pior que obra
//! nenhuma. Um IMDb trocado contaminaria índice, banco vivo, reserva BR e play
//! da obra ALHEIA; um `None` custa apenas a URL entrar em `no-work`. Daí as
//! quatro travas:
//!
//!   - nome: igualdade ESTRITA pós-normalização ([`adom_core::normalize_title`],
//!     a mesma do filtro de título do addon) contra o título localizado pt-BR OU
//!     o original do candidato. Sem prefixo, sem substring, sem sinônimo;
//!   - ano da PÁGINA: página sem ano declarado não entra em busca nenhuma —
//!     sem ano não há com que discriminar homônimo de qualquer época, e aceitar
//!     "o único que casou hoje" é chute com cara de acerto (`pagina-sem-ano`);
//!   - ano: tolerância ±1 (aplicada na busca, ver [`super::search`]) e candidato
//!     sem ano legível é descartado quando a página declara ano;
//!   - ambíguo: DUAS ou mais obras distintas casando (tmdb_id diferente) é
//!     [`IdentifyOutcome::Ambiguous`] → `None`. Nunca desempate por
//!     popularidade: o mais famoso não é o certo, é só o mais famoso.
//!
//! [`IdentifyOutcome::Unavailable`] (TMDB fora, sem chave, `external_ids`
//! falhou) é distinto de [`IdentifyOutcome::Unidentified`]: o primeiro é
//! retentável (o sidecar devolve 500), o segundo é estado próprio da página
//! (200 terminal). Nada aqui grava banco.

use adom_core::normalize_title;

use super::search::{
    external_imdb_id, search_by_title, SearchByTitleOptions, SearchWorkType, TmdbSearchApi,
    TmdbSearchHit,
};

/// Desfecho da identificação de UMA página.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentifyOutcome {
    /// Obra única casou e o IMDb id veio.
    Identified,
    /// Decisão autoritativa: não identificou (`None`, estado próprio).
    Unidentified,
    /// Dois ou mais homônimos válidos → `None` por segurança.
    Ambiguous,
    /// TMDB indisponível (retentável, NÃO é veredicto).
    Unavailable,
}

impl IdentifyOutcome {
    /// Rótulo estável (painel/log do motor).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Identified => "identified",
            Self::Unidentified => "unidentified",
            Self::Ambiguous => "ambiguous",
            Self::Unavailable => "unavailable",
        }
    }

    /// `true` = pode tentar de novo depois (500 ao sidecar, backoff).
    pub fn is_retryable(self) -> bool {
        self == Self::Unavailable
    }
}

/// Entrada da identificação de UMA página.
#[derive(Debug, Clone, Default)]
pub struct IdentifyInput<'a> {
    pub kind: SearchWorkType,
    /// Título da página (h1), sem ano.
    pub title: &'a str,
    /// Ano declarado pela página; `None`/`0` = página sem ano.
    pub year: Option<i64>,
    /// Título ORIGINAL declarado pela página: segundo nome com a MESMA régua
    /// estrita, segunda busca quando o `<h1>` não casa ninguém, e desempate de
    /// homônimo. Não é popularidade — é o site dizendo QUAL obra é.
    pub original_title: Option<&'a str>,
    /// Temporada que a PÁGINA declara. Com N≥2 o ano é o da temporada, não o da
    /// estreia, e a busca aceita série que estreou ANTES (`series_started_by`).
    pub season: Option<i64>,
}

/// Resultado da identificação.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentifyResult {
    pub outcome: IdentifyOutcome,
    /// IMDb id só em `identified`; em todo o resto é `None` — nunca um chute.
    pub imdb: Option<String>,
    /// Motivo curto e estável (agrupamento no painel/log do motor).
    pub reason: &'static str,
    /// Id TMDB da obra única, quando existiu (diagnóstico; nunca credencial).
    pub tmdb_id: Option<u64>,
}

impl IdentifyResult {
    fn unidentified(reason: &'static str) -> Self {
        Self {
            outcome: IdentifyOutcome::Unidentified,
            imdb: None,
            reason,
            tmdb_id: None,
        }
    }

    fn unavailable(reason: &'static str) -> Self {
        Self {
            outcome: IdentifyOutcome::Unavailable,
            imdb: None,
            reason,
            tmdb_id: None,
        }
    }

    fn with_tmdb_id(mut self, tmdb_id: u64) -> Self {
        self.tmdb_id = Some(tmdb_id);
        self
    }
}

/// Igualdade ESTRITA de nome: o título da página normalizado tem que ser IGUAL
/// ao título localizado ou ao original do candidato.
/// `normalize_title` tira acento/caixa/pontuação — "Expresso do Amanhã" e
/// "expresso do amanha" casam; "Snowpiercer" NÃO casa "Expresso do Amanhã".
pub fn strict_name_matches(page_title: &str, candidates: &[&str]) -> bool {
    let norm = normalize_title(page_title);
    if norm.is_empty() {
        return false;
    }
    candidates.iter().any(|candidate| {
        let norm_candidate = normalize_title(candidate);
        !norm_candidate.is_empty() && norm_candidate == norm
    })
}

/// Seleção do candidato entre os hits (JÁ filtrados por ano pela busca).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CandidateSelection {
    Unique {
        hit: TmdbSearchHit,
        by_original: bool,
    },
    Ambiguous {
        hits: Vec<TmdbSearchHit>,
    },
    NoMatch,
}

/// Nome estrito decide a entrada e a quantidade de obras DISTINTAS decide o
/// desfecho — uma é única, duas ou mais é homônimo ambíguo, zero é "não casou".
///
/// `original_title` (opcional) é o título original que a PÁGINA declarou: casa
/// pela mesma régua estrita e, com dois ou mais candidatos, desempata SÓ se
/// exatamente um deles tem esse `original_title` — "A Besta (2024)" com original
/// "La bête" é o Bonello, não o "A BESTA" homônimo do mesmo ano. Se a evidência
/// se DIVIDE (uns casam só o `<h1>`, outro só o original), o candidato só do
/// original vale apenas no ano da página (±1): o original da ficha às vezes é o
/// nome inglês, e a janela de temporada ≥ 2 é larga.
pub fn select_candidate(
    hits: &[TmdbSearchHit],
    page_title: &str,
    original_title: Option<&str>,
    page_year: Option<i64>,
) -> CandidateSelection {
    let original = original_title.unwrap_or("").trim();
    let names: Vec<&str> = if original.is_empty() {
        vec![page_title]
    } else {
        vec![page_title, original]
    };
    let matched: Vec<&TmdbSearchHit> = hits
        .iter()
        .filter(|hit| {
            names.iter().any(|name| {
                strict_name_matches(name, &[hit.title.as_str(), hit.original_title.as_str()])
            })
        })
        .collect();
    // Distintos por `tmdb_id`, ÚLTIMO vence — a mesma semântica do `Map` do TS.
    let mut distinct: Vec<&TmdbSearchHit> = Vec::new();
    for hit in matched {
        match distinct
            .iter_mut()
            .find(|existing| existing.tmdb_id == hit.tmdb_id)
        {
            Some(slot) => *slot = hit,
            None => distinct.push(hit),
        }
    }
    let by_h1 =
        |hit: &TmdbSearchHit| strict_name_matches(page_title, &[&hit.title, &hit.original_title]);
    let by_original = |hit: &TmdbSearchHit| {
        !original.is_empty() && strict_name_matches(original, &[&hit.original_title])
    };
    if distinct.is_empty() {
        return CandidateSelection::NoMatch;
    }
    if distinct.len() == 1 {
        let hit = distinct[0];
        return CandidateSelection::Unique {
            hit: hit.clone(),
            by_original: !by_h1(hit),
        };
    }
    // O candidato que casa as DUAS evidências (o `<h1>` e o original) vence.
    let both: Vec<&TmdbSearchHit> = distinct
        .iter()
        .copied()
        .filter(|hit| by_h1(hit) && by_original(hit))
        .collect();
    if both.len() == 1 {
        return CandidateSelection::Unique {
            hit: both[0].clone(),
            by_original: true,
        };
    }
    // Evidência DIVIDIDA — uns casam só pelo `<h1>`, outro só pelo original. O
    // original vale aqui só com o ANO da página: fora do ano é ambíguo.
    if distinct.iter().any(|hit| by_h1(hit)) && distinct.iter().any(|hit| !by_h1(hit)) {
        let original_only: Vec<&TmdbSearchHit> = distinct
            .iter()
            .copied()
            .filter(|hit| !by_h1(hit) && by_original(hit))
            .collect();
        let near = original_only.len() == 1
            && page_year.is_some_and(|page| {
                page > 0
                    && original_only[0]
                        .year
                        .is_some_and(|year| (year - page).abs() <= 1)
            });
        return if near {
            CandidateSelection::Unique {
                hit: original_only[0].clone(),
                by_original: true,
            }
        } else {
            CandidateSelection::Ambiguous {
                hits: owned(distinct),
            }
        };
    }
    let narrowed: Vec<&TmdbSearchHit> = distinct
        .iter()
        .copied()
        .filter(|hit| by_original(hit))
        .collect();
    if narrowed.len() == 1 {
        return CandidateSelection::Unique {
            hit: narrowed[0].clone(),
            by_original: true,
        };
    }
    CandidateSelection::Ambiguous {
        hits: owned(distinct),
    }
}

fn owned(hits: Vec<&TmdbSearchHit>) -> Vec<TmdbSearchHit> {
    hits.into_iter().cloned().collect()
}

/// Identifica a obra de uma página: busca no TMDB, aplica o casamento estrito e
/// resolve o IMDb id. Fail-open: nunca lança — erro de rede vira `unavailable`,
/// que é retentável, e a decisão só sai autoritativa quando a API respondeu.
pub async fn identify(api: &impl TmdbSearchApi, input: &IdentifyInput<'_>) -> IdentifyResult {
    let title = input.title.trim();
    // Página sem título é quebra de layout (o adaptador já devolve `error`);
    // aqui é só a guarda barata — sem rede.
    if title.is_empty() {
        return IdentifyResult::unidentified("pagina-sem-titulo");
    }
    // Página SEM ano não consulta o TMDB: o filtro de ano é local e sem ele
    // QUALQUER homônimo de qualquer época casaria o nome estrito. Não é falha e
    // não é retentativa de rede.
    let Some(page_year) = input.year.filter(|year| *year > 0) else {
        return IdentifyResult::unidentified("pagina-sem-ano");
    };
    // Post de temporada N≥2: o ano é da temporada (janela `series_started_by`).
    let options = SearchByTitleOptions {
        later_season: input.kind == SearchWorkType::Series
            && input.season.is_some_and(|season| season >= 2),
    };
    let search = search_by_title(api, input.kind, title, Some(page_year), options).await;
    if !search.ok {
        return IdentifyResult::unavailable("tmdb-indisponivel");
    }
    // Original igual ao `<h1>` não acrescenta nada (nem busca, nem desempate).
    let raw_original = input.original_title.unwrap_or("").trim();
    let original =
        if raw_original.is_empty() || normalize_title(raw_original) == normalize_title(title) {
            ""
        } else {
            raw_original
        };
    let mut hits = search.hits;
    let mut selection = select_candidate(&hits, title, Some(original), Some(page_year));
    // Segunda busca pelo ORIGINAL quando o `<h1>` não casou ninguém: o site
    // titula num pt-BR que o TMDB não tem ("A Armadilha do Coelho" = "Rabbit
    // Trap"). NÃO exigir zero hits na 1ª busca: a busca do TMDB é aproximada e
    // quase sempre devolve ALGO.
    if selection == CandidateSelection::NoMatch && !original.is_empty() {
        let second = search_by_title(api, input.kind, original, Some(page_year), options).await;
        if !second.ok {
            return IdentifyResult::unavailable("tmdb-indisponivel");
        }
        hits.extend(second.hits);
        selection = select_candidate(&hits, title, Some(original), Some(page_year));
    }
    if hits.is_empty() {
        return IdentifyResult::unidentified("tmdb-sem-resultado");
    }
    let (hit, by_original) = match selection {
        CandidateSelection::NoMatch => return IdentifyResult::unidentified("nome-sem-casamento"),
        CandidateSelection::Ambiguous { .. } => {
            return IdentifyResult {
                outcome: IdentifyOutcome::Ambiguous,
                imdb: None,
                reason: "homonimo-ambiguo",
                tmdb_id: None,
            }
        }
        CandidateSelection::Unique { hit, by_original } => (hit, by_original),
    };
    let external = external_imdb_id(api, hit.tmdb_id, input.kind).await;
    if !external.ok {
        return IdentifyResult::unavailable("tmdb-external-indisponivel").with_tmdb_id(hit.tmdb_id);
    }
    let Some(imdb) = external.imdb else {
        return IdentifyResult::unidentified("obra-sem-imdb").with_tmdb_id(hit.tmdb_id);
    };
    // Motivo distinto para o painel/métrica separarem o que o original recuperou.
    IdentifyResult {
        outcome: IdentifyOutcome::Identified,
        imdb: Some(imdb),
        reason: if by_original {
            "casamento-titulo-original"
        } else {
            "casamento-unico"
        },
        tmdb_id: Some(hit.tmdb_id),
    }
}

impl super::TmdbClient {
    /// [`identify`] com o cliente TMDB como fonte.
    pub async fn identify(&self, input: &IdentifyInput<'_>) -> IdentifyResult {
        identify(self, input).await
    }
}

#[cfg(test)]
#[path = "identify_http_tests.rs"]
mod http_tests;
#[cfg(test)]
#[path = "identify_tests.rs"]
mod tests;
