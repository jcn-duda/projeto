//! Tipos das VARREDURAS de conteúdo da AllDebrid: modo, motivo, plano e fatos.
//! Nada aqui faz I/O nem lê env: o chamador monta os fatos (inventário, holds,
//! `adsub`/`adrm`/`adprot`) e passa o [`SweepMode`] — decisão pura primeiro,
//! rede depois, como em `cleanup_plan`.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;

/// `DEAD` do Node (`alldebrid-api.ts`): a autoridade do terminal é o TEXTO do
/// status — `statusCode` não decide. Cópia local de propósito: a mesma regex
/// vive privada em `alldebrid_autofetch.rs` e aquele arquivo não é desta fatia.
static DEAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("(?i)no peer|expired|not available|error|failed|download took more than 3 days")
        .unwrap()
});
/// `ACTIVE_STATES` do Node: download em curso não é lixo.
static ACTIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("(?i)^(?:queued|downloading|processing|compressing|moving|uploading)$").unwrap()
});

/// Marcadores PT default (mesma lista de `config.audioAudit.ptMarkers`). Cópia
/// local: a lista de `play_audit` é privada e o dono daquele arquivo não é
/// esta fatia.
pub(crate) const DEFAULT_PT: &[&str] = &[
    "dublado",
    "dublada",
    "dublagem",
    "dubbed",
    "dual audio",
    "dual",
    "pt br",
    "ptbr",
    "portugues",
    "portuguese",
    "nacional",
    "fleg",
];

/// Grupos de cena EN default (`config.audioAudit.enGroups`). Plataforma
/// (amzn, dsnp) não entra: só grupo de cena prova inglês.
pub(crate) const DEFAULT_EN: &[&str] = &[
    "rarbg", "killers", "ettv", "afm72", "tovar", "evo", "megusta", "galaxyrg", "glxrc", "yts",
    "fgt", "ntb", "roarb", "oxy", "bae", "drs", "huzzah", "tgx", "ethel", "yify",
];

/// Ligação da varredura com a destruição (`Off` por default: sem pedido do
/// chamador, nada é decidido nem apagado).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SweepMode {
    /// Nada roda: nem plano, nem I/O.
    #[default]
    Off,
    /// Monta/carrega os fatos e devolve o plano, mas **nenhum** `DELETE` sai.
    ReadOnly,
    /// Aplica o plano (ainda com `may_delete` fail-closed no instante do
    /// delete).
    Apply,
}

impl SweepMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "readonly" | "read_only" | "read-only" | "shadow" => Self::ReadOnly,
            "on" | "1" | "true" | "yes" | "apply" | "rust" => Self::Apply,
            _ => Self::Off,
        }
    }

    /// Composição das DUAS flags do corte (`DEBRID_AL_CLEANUP` e
    /// `DEBRID_AL_CLEANUP_KILL`), já lidas pelo chamador: limpeza OFF ⇒ `Off`;
    /// kill-switch ligado ⇒ `ReadOnly` (o plano continua, o delete não).
    pub fn from_flags(cleanup_on: bool, kill_on: bool) -> Self {
        match (cleanup_on, kill_on) {
            (false, _) => Self::Off,
            (true, true) => Self::ReadOnly,
            (true, false) => Self::Apply,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::ReadOnly => "read_only",
            Self::Apply => "apply",
        }
    }

    /// O plano pode ser montado (leitura de fatos/rede de status)?
    pub fn plans(self) -> bool {
        matches!(self, Self::ReadOnly | Self::Apply)
    }

    /// O `DELETE` pode sair?
    pub fn deletes(self) -> bool {
        matches!(self, Self::Apply)
    }
}

/// Qual varredura produziu o plano (diagnóstico e métrica).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SweepKind {
    /// Magnet em estado terminal (lixo que ocupa vaga).
    Dead,
    /// Magnet pronto/antigo com áudio estrangeiro PROVADO nos arquivos.
    Undubbed,
    /// Posse (`adsub`) que sobrou na conta real.
    Reconcile,
    /// Fila de represados reavaliada em fundo.
    Revalidate,
}

impl SweepKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dead => "sweepDead",
            Self::Undubbed => "sweepUndubbed",
            Self::Reconcile => "reconcile",
            Self::Revalidate => "revalidate",
        }
    }

    /// Vocabulário da rota manual (`POST /sweeps/run`): aceita os nomes
    /// canônicos de [`Self::as_str`] em qualquer caixa e com `_`/`-`
    /// (`sweep_dead`, `sweep-undubbed`). Desconhecido ⇒ `None`: um `unwrap_or`
    /// aqui apagaria o tipo errado.
    pub fn parse(raw: &str) -> Option<Self> {
        let normalized: String = raw
            .trim()
            .chars()
            .filter(|ch| *ch != '_' && *ch != '-')
            .map(|ch| ch.to_ascii_lowercase())
            .collect();
        match normalized.as_str() {
            "sweepdead" => Some(Self::Dead),
            "sweepundubbed" => Some(Self::Undubbed),
            "reconcile" => Some(Self::Reconcile),
            "revalidate" => Some(Self::Revalidate),
            _ => None,
        }
    }
}

/// Por que um hash NÃO saiu. Cada motivo é contado: é o diagnóstico que prova
/// a régua viva sem apagar acervo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Sem snapshot `knownBefore`: fail-safe fechado, ninguém sai.
    InventoryMissing,
    /// Hold volátil do autofetch (download em voo).
    Held,
    /// Retenção BR durável (`adprot:v1`).
    RetentionBr,
    /// Já estava na conta antes do upload (`knownBefore`).
    Preexisting,
    /// Anti-reenchimento (`adrm:v1`): já foi apagado de propósito.
    Marked,
    /// Pronto é acervo, não lixo (`sweepDead`).
    Ready,
    /// Estado não é terminal — nada a varrer.
    NotDead,
    /// Não está pronto e não é terminal: o reconcile não mexe.
    NotReady,
    /// Download em curso (`ACTIVE_STATES`).
    Active,
    /// Jovem demais para a varredura (piso de idade).
    TooYoung,
    /// `uploadDate` ausente/ilegível: a idade não está provada.
    NoUploadDate,
    /// `sweepUndubbed` sem caminho de vídeo: título nunca condena.
    NoAudioProof,
    /// Sinal PT nos arquivos: absolvido.
    PtProof,
    /// Áudio ambíguo (`unknown`): fica para a auditoria de arquivos.
    ForeignUnknown,
    /// Reconcile/revalidate sem posse (`adsub`) provada.
    NoOwnership,
    /// Upload mais novo que a etiqueta de posse: re-add do usuário.
    Readded,
    /// Hash consultado por ESTA busca (upload da própria checagem).
    ConsultedThisSearch,
    /// Hash fora da fila de represados desta rodada.
    NotSuppressed,
    /// Represado que sumiu da conta: o chamador cura, nada a apagar.
    Gone,
    /// Piso de ocupação: conta folgada não é varrida.
    Floor,
    /// Teto por rodada atingido (os mais antigos saem primeiro).
    CapExceeded,
    /// Linha sem `id`: não há o que pedir ao `/magnet/delete`.
    MissingId,
    /// Linha sem hash: sem identidade não há decisão.
    NoHash,
    /// `may_delete` fechou no instante do delete (hold/preexistente novo).
    GuardClosed,
    /// O `/magnet/delete` recusou (transitório): o magnet continua na conta.
    DeleteFailed,
    /// A conta parou a rodada (quota/auth): o resto nem foi tentado.
    Stopped,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InventoryMissing => "inventory_missing",
            Self::Held => "held",
            Self::RetentionBr => "retention_br",
            Self::Preexisting => "preexisting",
            Self::Marked => "marked",
            Self::Ready => "ready",
            Self::NotDead => "not_dead",
            Self::NotReady => "not_ready",
            Self::Active => "active",
            Self::TooYoung => "too_young",
            Self::NoUploadDate => "no_upload_date",
            Self::NoAudioProof => "no_audio_proof",
            Self::PtProof => "pt_proof",
            Self::ForeignUnknown => "foreign_unknown",
            Self::NoOwnership => "no_ownership",
            Self::Readded => "readded",
            Self::ConsultedThisSearch => "consulted_this_search",
            Self::NotSuppressed => "not_suppressed",
            Self::Gone => "gone",
            Self::Floor => "floor",
            Self::CapExceeded => "cap_exceeded",
            Self::MissingId => "missing_id",
            Self::NoHash => "no_hash",
            Self::GuardClosed => "guard_closed",
            Self::DeleteFailed => "delete_failed",
            Self::Stopped => "stopped",
        }
    }
}

/// Uma linha do `/magnet/status`: identidade (`id`/`hash`), estado, idade
/// (`uploaded_at_ms`, 0 = ilegível) e PROVA de áudio (`files` — caminhos de
/// vídeo; vazio = sem prova, e título nunca substitui a prova).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MagnetRow {
    pub id: String,
    pub hash: String,
    pub name: String,
    pub status: String,
    pub ready: bool,
    /// Epoch em ms (`uploadDate` × 1000 do Node). `0` = não provado.
    pub uploaded_at_ms: i64,
    /// Caminhos de vídeo: a ÚNICA prova de áudio aceita pelo `sweepUndubbed`.
    pub files: Vec<String>,
}

impl MagnetRow {
    /// Hash normalizado (`trim` + caixa baixa) — a chave do plano.
    pub fn normalized_hash(&self) -> String {
        self.hash.trim().to_lowercase()
    }

    /// `ready` do flag ou do texto (`/^ready$/i`), como no Node.
    pub fn is_ready(&self) -> bool {
        self.ready || self.status.trim().eq_ignore_ascii_case("ready")
    }

    pub fn is_active(&self) -> bool {
        ACTIVE.is_match(self.status.trim())
    }

    /// Terminal pelo TEXTO (`DEAD`). `statusCode` nunca decide.
    pub fn is_dead(&self) -> bool {
        DEAD.is_match(&self.status)
    }

    /// `id` utilizável (o que o `/magnet/delete` recebe), se houver.
    pub fn usable_id(&self) -> Option<&str> {
        let id = self.id.trim();
        (!id.is_empty()).then_some(id)
    }
}

/// Resultado da decisão. `delete`/`keep` são HASHES normalizados; o `id` que o
/// `/magnet/delete` recebe sai da linha em `apply_plan`. `skip` repete o motivo
/// de cada hash mantido — é o que vira contagem por categoria.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepPlan {
    pub kind: SweepKind,
    pub delete: Vec<String>,
    pub keep: Vec<String>,
    pub skip: BTreeMap<String, Reason>,
}

impl SweepPlan {
    #[must_use]
    pub fn new(kind: SweepKind) -> Self {
        Self {
            kind,
            delete: Vec::new(),
            keep: Vec::new(),
            skip: BTreeMap::new(),
        }
    }

    /// Mantém o hash e registra o motivo (o par `keep`/`skip` anda junto).
    pub fn keep_with(&mut self, hash: impl Into<String>, reason: Reason) {
        let hash = hash.into();
        self.keep.push(hash.clone());
        self.skip.insert(hash, reason);
    }

    /// Autoriza o delete do hash (o executor ainda revalida `may_delete`).
    pub fn queue_delete(&mut self, hash: impl Into<String>) {
        self.delete.push(hash.into());
    }

    pub fn is_empty(&self) -> bool {
        self.delete.is_empty()
    }

    /// Quantos hashes caíram em cada motivo (contagem por categoria).
    #[must_use]
    pub fn reason_counts(&self) -> BTreeMap<&'static str, usize> {
        let mut out: BTreeMap<&'static str, usize> = BTreeMap::new();
        for reason in self.skip.values() {
            *out.entry(reason.as_str()).or_default() += 1;
        }
        out
    }

    pub fn count(&self, reason: Reason) -> usize {
        self.skip.values().filter(|item| **item == reason).count()
    }
}
