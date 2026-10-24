use std::collections::{BTreeMap, HashMap, HashSet};

use adom_core::DebridFile;

/// Contexto da obra + injeções de I/O que o TS lia de bancos (a busca nativa
/// recebe tudo pronto; NADA de rede aqui).
#[derive(Debug, Clone, Default)]
pub struct BuildContext {
    /// Nomes da obra (aliases já resolvidos — `resolveSearchNames`).
    pub names: Vec<String>,
    /// Ano de catálogo como texto (`String(year ?? '')`, sujo "2024–" vale).
    pub year: String,
    /// Ano dual (Monster).
    pub alt_year: Option<String>,
    /// Raiz da coleção multiobra (opt-in TMDB), quando há.
    pub multi_work_root: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub is_demo: bool,
    /// `debrid.current() != null` — há adapter para escolher arquivo em pack.
    pub debrid_available: bool,
    /// `adapter.cacheCheck` — o debrid diz o que está pronto?
    pub debrid_cache_check_honest: bool,
    /// Há chave de debrid na conta?
    pub debrid_has_key: bool,
    /// `opts().debridCachedOnly`.
    pub debrid_cached_only: bool,
    /// `opts().showUncachedBr` — vagas P2P BR fora do cache (exceção ao corte).
    pub show_uncached_br: bool,
    /// `DEBRID_RESOLVE_UNCACHED` do operador — o frio sai pelo `/resolve` em
    /// vez de P2P. Vem da config da instalação, nunca do segmento do usuário.
    /// Só vale com debrid ATIVO e veredito utilizável: sem serviço/chave
    /// (`NoDebridCheck`) ou com `Unusable` (auth/quota) o Node mantém P2P e
    /// descarta multiobra — o `/resolve` morreria na conta que não responde.
    pub debrid_resolve_uncached: bool,
    /// Sombra §9.1: a checagem foi suprimida (`NoDebridCheck`), então
    /// `Unknown` NÃO significa lote degradado — nada vira `/resolve`.
    pub debrid_check_disabled: bool,
    /// Estreia do episódio (`Date.parse(airDate)`) em ms; `None` = sem data.
    pub episode_aired_at_ms: Option<i64>,
    /// 1º lançamento doméstico do filme (TMDB, epoch ms) — `homeReleaseAt` do
    /// `matchContext`/`peekHomeReleaseAt` do Node. `None` = sem data (e o corte
    /// pré-home-release não roda).
    pub home_release_at: Option<i64>,
    /// Contagem de episódios por temporada (Cinemeta): `[(temporada, n)]`.
    pub episode_counts: Vec<(i64, i64)>,
    /// `first_seen` do banco de magnets vivo por hash (injetado).
    pub first_seen_ms: HashMap<String, f64>,
    /// Títulos pt/original/en do TMDB: contexto da recuperação de DUAL global
    /// (`ptTitleDual`). O build decide in-process — não depende da flag que a
    /// rota de coleta manda no item.
    pub titles: Option<adom_core::PtTitleDualTitles>,
    /// Bases normalizadas de executáveis do acervo desta obra (corte 2).
    pub executable_bases: Vec<String>,
    /// Lista de arquivos por hash (memo `fsz` do Node). É o que dá `💾` ao
    /// pack (média do episódio) e ao item que o tracker deixou sem tamanho —
    /// o `annotateEpisodeSizes`/`fillMissingSizes` do Node, injetado.
    pub files_by_hash: BTreeMap<String, Vec<DebridFile>>,
    /// Total do torrent (memo `tsz` do Node) por hash: o `💾` de quem veio sem
    /// tamanho quando não há lista de arquivos. Injetado pelo replay congelado.
    pub totals_by_hash: BTreeMap<String, f64>,
    /// Estado do memo na passada PRÉ-debrid (1ª anotação do Node). `None` =
    /// captura antiga/sem o arquivo: a 1ª passada segue a régua anterior.
    pub files_at_build: Option<BTreeMap<String, Vec<DebridFile>>>,
    pub totals_at_build: Option<BTreeMap<String, f64>>,
    /// Hashes que o PLAY desta conta já provou quebrados (`bad`/`lie` do banco
    /// de magnets, lidos do `cache.db` pelo gateway). Vazio = sem fonte: o build
    /// não poda nada além do `broken` que vem no item.
    pub broken_hashes: HashSet<String>,
    /// Relógio da build (ms desde a época).
    pub now_ms: i64,
}
