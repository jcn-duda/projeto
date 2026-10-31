//! Escritas do efeito do play, uma por store (porte de `rust-resolve-*.ts`,
//! `rust-play-effects.ts` e `magnetdb`/`davail`/`rd-ledger` do lado Node).
//! Cada escrita respeita o próprio gate do TS (kill-switch e TTL > 0), e só
//! falha em log.

use adom_core::{
    account_scope, ledger_key, next_on_blocked, play_file_evidence, DebridFile, WorkTarget,
};
use adom_debrid::alldebrid::PlayFile;
use adom_debrid::file_sizes::record_files;
use adom_index::{FileEvidence, MagMetaSums, MagnetStateStore};
use serde_json::{json, Value};

use crate::dub_audit::DEFAULT_LIE_TTL;

use super::plan::{EffectPlan, IndexMark, Invalidate, Mark};
use super::{grava, NativePlayEffects, PlayJob};

impl NativePlayEffects {
    /// Arquivos do play: tamanho do episódio (`fsz`) e a prova de áudio e
    /// resolução (`idx:file`) que a busca seguinte e o interrogatório leem.
    pub(super) fn apply_files(&self, job: &PlayJob, files: Option<&[PlayFile]>, now: i64) {
        let Some(files) = files else {
            return;
        };
        let list: Vec<DebridFile> = files
            .iter()
            .map(|file| DebridFile {
                path: file.path.clone(),
                size: file.size,
            })
            .collect();
        if let Some(kv) = self.kv() {
            grava("fsz", record_files(kv, &job.hash, &list, now));
        }
        let Some(evidence) = play_file_evidence(&list) else {
            return;
        };
        let Some(index) = &self.index else {
            return;
        };
        // O TS grava `e` sempre (0 ou 1): a ausência de `e` só vale para as
        // linhas antigas, não para o que o play prova.
        let row = FileEvidence {
            a: evidence.audio,
            e: Some(u8::from(evidence.en)),
            q: evidence.quality,
            n: evidence.name,
        };
        grava(
            "prova de arquivo",
            index.mark_file_evidence(&job.hash, &row, now),
        );
    }

    /// Frio medido pelo play: davail=0 pela janela curta. Não toca no magnet.
    pub(super) fn note_unavailable(&self, job: &PlayJob, now: i64) {
        let ttl = self.cfg.avail_neg_ttl;
        if ttl <= 0 {
            return;
        }
        if let Some(davail) = &self.davail {
            grava(
                "davail negativo",
                davail.put(&job.service, &job.api_key, &job.hash, false, ttl, now),
            );
        }
    }

    /// Magnet vivo (o play devolveu link). `bad` ativo não é ressuscitado pelo
    /// núcleo do store.
    pub(super) fn mark_alive(&self, job: &PlayJob, now: i64) {
        if !self.cfg.magnet_db || self.cfg.alive_ttl <= 0 {
            return;
        }
        let Some(mag) = &self.mag else {
            return;
        };
        let born = match mag.mark_alive(
            &job.service,
            &job.api_key,
            std::slice::from_ref(&job.hash),
            self.cfg.alive_ttl,
            now,
        ) {
            Ok(born) => born,
            Err(err) => {
                grava::<()>("magnet vivo", Err(err));
                return;
            }
        };
        // Só o que NASCEU muda o acervo: renovação não sobe contagem.
        if born > 0 {
            bump_meta(
                mag,
                &job.service,
                alive_delta(born as i64, 0),
                MagMetaSums {
                    alive: born as i64 * self.cfg.alive_ttl,
                    ..MagMetaSums::default()
                },
                self.cfg.alive_ttl,
                now,
            );
        }
    }

    /// Efeito plano do erro, na ordem do TS: magnet, cache, índice e ledger.
    pub(super) fn apply_plan(&self, job: &PlayJob, plan: &EffectPlan, now: i64) {
        self.apply_magnet(job, plan, now);
        match plan.invalidate {
            Invalidate::Obra => self.invalidate_obra(job),
            Invalidate::Streams => self.invalidate_blocked(now),
            Invalidate::None => {}
        }
        self.apply_index(job, plan.index, now);
        // Ledger do RD só no bloqueio legal dele: o núcleo já manda `noteBlocked`
        // só para `realdebrid`, e o gate repete a régua do TS.
        if plan.note_blocked && job.service == "realdebrid" {
            self.note_rd_blocked(job, now);
        }
    }

    fn apply_magnet(&self, job: &PlayJob, plan: &EffectPlan, now: i64) {
        // Sem conta não há chave de magnet (o TS também saía aqui).
        if job.service.is_empty() || job.api_key.is_empty() {
            return;
        }
        match plan.mark {
            Some(Mark::Bad) => self.mark_bad(job, now),
            Some(Mark::Lie) => {
                self.mark_lie(job, now);
                // A promessa de dublado caiu: a proteção durável da conta sai.
                if plan.unprotect {
                    self.unprotect(job);
                }
            }
            None => {}
        }
    }

    fn mark_bad(&self, job: &PlayJob, now: i64) {
        if !self.cfg.magnet_db || self.cfg.bad_ttl <= 0 {
            return;
        }
        let Some(mag) = &self.mag else {
            return;
        };
        // O `bad` nascente apaga o `alive` vivo do mesmo hash NA MESMA
        // transação (`magnet_state.rs`): o delta do agregado precisa saber se
        // existia ANTES da escrita — leitura por chave, O(1) como a marca. Se a
        // leitura falhar, não desconta (o rebuild do painel reconta depois).
        let scope = account_scope(&Value::String(job.api_key.clone()));
        let had_alive = mag
            .peek_mark_scoped("alive", &job.service, &scope, &job.hash, now)
            .unwrap_or(false);
        let born = match mag.mark_bad(&job.service, &job.api_key, &job.hash, self.cfg.bad_ttl, now)
        {
            Ok(born) => born,
            Err(err) => {
                grava::<()>("magnet ruim", Err(err));
                return;
            }
        };
        if born || had_alive {
            bump_meta(
                mag,
                &job.service,
                alive_delta(-i64::from(had_alive), i64::from(born)),
                MagMetaSums {
                    alive: i64::from(had_alive) * -(self.cfg.alive_ttl.max(0)),
                    bad: i64::from(born) * self.cfg.bad_ttl,
                    lie: 0,
                },
                self.cfg.bad_ttl,
                now,
            );
        }
    }

    fn mark_lie(&self, job: &PlayJob, now: i64) {
        if !self.cfg.magnet_db || !self.cfg.lie_enabled || self.cfg.lie_ttl <= 0 {
            return;
        }
        let Some(mag) = &self.mag else {
            return;
        };
        let born = match mag.mark_lie(&job.service, &job.api_key, &job.hash, self.cfg.lie_ttl, now)
        {
            Ok(born) => born,
            Err(err) => {
                grava::<()>("magnet mentiroso", Err(err));
                return;
            }
        };
        // O `lie` NÃO apaga o `alive`: os dois lados coexistem no acervo e no
        // agregado (`magnet_state.rs`, mesma semântica do TS).
        if born {
            bump_meta(
                mag,
                &job.service,
                MagMetaSums {
                    lie: 1,
                    ..MagMetaSums::default()
                },
                MagMetaSums {
                    lie: self.cfg.lie_ttl,
                    ..MagMetaSums::default()
                },
                self.cfg.lie_ttl,
                now,
            );
        }
    }

    /// Apaga a retenção `adprot` da conta: mesma chave do `unprotect` do TS e
    /// do interrogatório (`dub_audit_writes`).
    fn unprotect(&self, job: &PlayJob) {
        if job.hash.is_empty() {
            return;
        }
        let Some(kv) = self.kv() else {
            return;
        };
        let account = account_scope(&Value::String(job.api_key.clone()));
        if account == "none" {
            return;
        }
        let key = format!(
            "adprot:v1:{}:{account}:{}",
            job.service,
            job.hash.to_ascii_lowercase()
        );
        grava("adprot", kv.forget(&key));
    }

    /// Limpa as listas prontas da obra (só a obra, por IMDb).
    fn invalidate_obra(&self, job: &PlayJob) {
        if !is_imdb(&job.imdb) {
            return;
        }
        let Some(streams) = &self.streams else {
            return;
        };
        match streams.invalidate_for_obra(&job.imdb) {
            Ok(0) => {}
            Ok(removed) => eprintln!(
                "[resolve] invalidou {removed} entrada(s) de streams da obra {} após o erro do play",
                job.imdb
            ),
            Err(err) => eprintln!("[resolve] invalidação da obra {} falhou: {err}", job.imdb),
        }
    }

    /// Bloqueio legal (451): limpa a lista inteira, com cooldown. O instante
    /// fica em `last_blocked_clear_ms` sob o mesmo lock da decisão, para duas
    /// requisições concorrentes não pedirem a limpeza juntas.
    fn invalidate_blocked(&self, now: i64) {
        let cooldown = self.cfg.blocked_cooldown_ms;
        // 0 desliga: nem escreve nem avança o instante.
        if cooldown <= 0 {
            return;
        }
        let Some(streams) = &self.streams else {
            return;
        };
        let Ok(mut last) = self.last_blocked_clear_ms.lock() else {
            return;
        };
        if !blocked_clear_due(*last, now, cooldown) {
            return;
        }
        *last = now;
        drop(last);
        match streams.clear_all() {
            Ok(removed) => eprintln!(
                "[resolve] limpeza do streams.db após bloqueio legal ({removed} entrada(s)); \
                 a próxima abertura não oferece mais este hash pelo debrid"
            ),
            Err(err) => eprintln!("[resolve] limpeza do streams.db após 451 falhou: {err}"),
        }
    }

    fn apply_index(&self, job: &PlayJob, mark: Option<IndexMark>, now: i64) {
        let Some(mark) = mark else {
            return;
        };
        if !is_imdb(&job.imdb) {
            return;
        }
        let Some(index) = &self.index else {
            return;
        };
        let target = WorkTarget {
            season: job.season,
            episode: job.episode,
        };
        match mark {
            IndexMark::Lied => grava(
                "prova de dublagem falsa",
                index.mark_lied(&job.imdb, target, &job.hash, now),
            ),
            IndexMark::Missing | IndexMark::MissingSeason => {
                // Episódio ausente só se prova com S e E; sem eles não há o que marcar.
                if job.season.is_some() && job.episode.is_some() {
                    grava(
                        "episódio ausente",
                        index.mark_missing(&job.imdb, target, &job.hash, now),
                    );
                }
                // O arquivo não declara episódio nenhum: a temporada inteira deste hash cai.
                if mark == IndexMark::MissingSeason {
                    if let Some(season) = job.season {
                        grava(
                            "temporada ausente",
                            index.mark_missing_season(&job.imdb, season, &job.hash, now),
                        );
                    }
                }
            }
        }
    }

    /// Transição `blocked` do ledger `rdc:v2`, com o TTL do bloqueio. Escreve
    /// por cima: `blocked` não cede a hit/miss, e o próprio bloqueio renova.
    fn note_rd_blocked(&self, job: &PlayJob, now: i64) {
        let Some(kv) = self.kv() else {
            return;
        };
        let Some(write) = next_on_blocked(
            self.cfg.rd_ledger,
            &job.hash,
            self.cfg.rd_blocked_ttl,
            now as f64,
        ) else {
            return;
        };
        let Some(hash) = write.hash.as_deref() else {
            return;
        };
        let value = json!({ "s": write.s, "at": write.at as i64, "n": write.n as i64 });
        grava(
            "ledger do RD bloqueado",
            kv.put_json(&ledger_key(hash), &value, write.ttl_seconds as i64, now),
        );
    }
}

/// Cooldown da limpeza por bloqueio: a primeira sempre passa (`last` = 0).
pub(super) fn blocked_clear_due(last_ms: i64, now: i64, cooldown_ms: i64) -> bool {
    now - last_ms >= cooldown_ms
}

/// Delta de contagem com `alive` e `bad` nomeados (o `lie` fica 0).
fn alive_delta(alive: i64, bad: i64) -> MagMetaSums {
    MagMetaSums { alive, bad, lie: 0 }
}

/// Agregado `mag_meta:v1:counts` acompanha a marca (O(1), mesmo movimento do
/// Node em `magnetdb-persist.ts`): contagem sobe com o que NASCEU e a soma de
/// TTL recebe o TTL nominal por linha nascida. Falha só loga (`grava`).
fn bump_meta(
    mag: &MagnetStateStore,
    adapter: &str,
    counts: MagMetaSums,
    ttl_sums: MagMetaSums,
    mark_ttl: i64,
    now: i64,
) {
    // O TTL da LINHA segue o desenho do Node: piso de 7 dias — o agregado não
    // é janela de evidência, apagá-lo só custa um rebuild (`magnet_meta.rs`).
    grava(
        "agregado do magnetdb",
        mag.bump_counts(
            adapter,
            counts,
            ttl_sums,
            mark_ttl.max(DEFAULT_LIE_TTL),
            now,
        )
        .map(|_| ()),
    );
}

/// `tt` + dígitos, a mesma forma do `/^tt\d+$/` do TS.
pub(super) fn is_imdb(id: &str) -> bool {
    id.strip_prefix("tt")
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}
