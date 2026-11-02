/**
 * Camada de abertura e persistência SQLite do cache multi-nível. O L1 nasce
 * vazio: desde a F3 da guilhotina o boot não sobe linha nenhuma, só poda.
 *
 * FÁBRICA, não módulo de estado: o handle do banco, os prepared statements, a
 * fila de despejo (`pending`) e o flush agendado nascem dentro da closure
 * criada por `createPersistence()`, que o cache.ts invoca no próprio corpo.
 * Estado mutável num módulo irmão quebraria o cache-busting dos testes
 * (`cache.js?query` criaria instância nova de cache.ts reusando o irmão
 * cacheado). O L1 entra via hooks — este módulo não conhece o store dono.
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import * as log from './logger.js';
import { NAMESPACE_VERSIONS, LEGACY_PREFIXES, RUST_OWNED, RUST_OWNED_PREFIXES, isRustOwned, isForeignKey } from './cache-keys.js';
import { namespaceFor } from './cache-quotas.js';
import { openWithRecovery } from './cache-db-open.js';

export function createPersistence() {
  const DB_PATH = config.cache.dbPath;
  let db: any = null;
  let insertStmt: any = null;
  let deleteStmt: any = null;
  let deleteExpiredStmt: any = null;
  let deleteStaleStmt: any = null;
  let deleteLegacyStmt: any = null;
  let clearStmt: any = null;

  // Prefixos que a poda do Node NUNCA apaga: donos com ciclo próprio no arquivo.
  const ownedGuards = [
    ...[...RUST_OWNED].map((ns) => `${ns}:%`),
    ...RUST_OWNED_PREFIXES.map((owned) => `${owned}%`),
  ];
  const guardSql = ownedGuards.map(() => ' AND key NOT LIKE ?').join('');

  // Escrita em LOTE: a chave é marcada aqui e despejada no próximo tick numa
  // transação só (mesmo racional do forgetMany). Queda do processo perde o
  // lote do tick corrente — aceitável, o L2 é best-effort e o passe tardio
  // reconstrói na busca seguinte.
  const pending = new Map();
  let flushScheduled: ReturnType<typeof setImmediate> | null = null;

  function open() {
    if (!config.cache.persist) return null;
    try {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      // A abertura lazy (node:sqlite) e a recuperação de corrupção moram em
      // cache-db-open.js — só corrupção REAL autoriza o rename destrutivo do
      // banco; erro transiente rethrow e cai no catch de fora (só memória).
      const database = openWithRecovery(DB_PATH);

      insertStmt = database.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');
      deleteStmt = database.prepare('DELETE FROM cache WHERE key = ?');
      // Expirado: o Node poda só o próprio L2 (`ownedGuards`).
      deleteExpiredStmt = database.prepare(`DELETE FROM cache WHERE expires_at <= ?${guardSql}`);
      // Descarte de versão obsoleta: o CAST lê o número de `<ns>:v<N>:...` (para
      // no `:`), sem materializar a linha no JS.
      deleteStaleStmt = database.prepare('DELETE FROM cache WHERE key LIKE ? AND CAST(substr(key, ?) AS INTEGER) < ?');
      deleteLegacyStmt = database.prepare('DELETE FROM cache WHERE key LIKE ?');
      clearStmt = database.prepare('DELETE FROM cache');

      db = database;
      return database;
    } catch (err: unknown) {
      log.warn('[cache] persistência indisponível, seguindo só em memória:', log.errorMessage(err));
      insertStmt = null;
      deleteStmt = null;
      deleteExpiredStmt = null;
      deleteStaleStmt = null;
      deleteLegacyStmt = null;
      clearStmt = null;
      return null;
    }
  }

  /**
   * Máxima janela de graça entre os consumidores do cache. Hoje só as listas de
   * stream usam (SWR); as podas precisam respeitá-la, senão o timer de
   * 10 min apaga a entrada expirada antes de o refresh de fundo poder servi-la.
   */
  function maxGraceMs() {
    return Math.max(0, config.streamStaleGrace) * 1000;
  }

  /**
   * Poda do boot, sem subir nada: nenhum consumidor lê o L1, e varrer a tabela
   * inteira do gateway a cada restart só custava memória e I/O.
   */
  function pruneOnBoot() {
    if (!db || !deleteExpiredStmt || !deleteStaleStmt || !deleteLegacyStmt) return;
    try {
      deleteExpiredStmt.run(Date.now() - maxGraceMs(), ...ownedGuards);
      // Só versão MENOR que a conhecida: o gateway pode subir a de um namespace
      // dele antes do TS, e a linha nova não é lixo. `idx` é do Rust ponta a ponta.
      for (const [ns, version] of Object.entries(NAMESPACE_VERSIONS)) {
        if (ns !== 'idx') deleteStaleStmt.run(`${ns}:v%`, ns.length + 3, Number(version.slice(1)));
      }
      for (const legacy of LEGACY_PREFIXES) deleteLegacyStmt.run(`${legacy}%`);
    } catch (err) {
      log.warn('[cache] falha ao podar o disco no boot:', err.message);
    }
  }

  function flushPending() {
    if (!db || !insertStmt || pending.size === 0) return;
    const batch = [...pending.entries()];
    pending.clear();
    try {
      db.exec('BEGIN');
      try {
        for (const [key, entry] of batch) {
          insertStmt.run(key, JSON.stringify(entry.value), entry.expiresAt);
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignora falha de rollback se a transação já foi abortada */
        }
        throw err;
      }
    } catch (err) {
      log.warn('[cache] falha ao gravar lote no disco:', err.message);
    }
  }

  function scheduleFlush() {
    if (flushScheduled || !insertStmt) return;
    flushScheduled = setImmediate(() => {
      flushScheduled = null;
      flushPending();
    });
    // Sem unref o despejo pendurado manteria o processo vivo no shutdown.
    flushScheduled.unref?.();
  }

  function persist(key: string, value: unknown, expiresAt: number) {
    if (!insertStmt) return;
    // RUST_OWNED vive no mesmo cache.db: o L2 do Node não regrava.
    if (isRustOwned(namespaceFor(key)) || isForeignKey(key)) return;
    // A última escrita da chave é a que vale; o Map já substitui a anterior.
    pending.set(key, { value, expiresAt });
    scheduleFlush();
  }

  function forget(key: string, removeFromStore: (key: string) => boolean) {
    removeFromStore(key);
    // Se a chave ainda está na fila de despejo, o lote não pode ressuscitá-la.
    pending.delete(key);
    if (!deleteStmt) return;
    try {
      deleteStmt.run(key);
    } catch {
      /* limpeza é best-effort: o TTL em memória já protege a leitura */
    }
  }

  /**
   * Apaga um LOTE em uma transação só. Fora dela o node:sqlite dá commit
   * implícito por statement, cada um com seu fsync no WAL: uma varredura que
   * expira muitas chaves de uma vez vira um commit por chave, síncrono, no meio
   * do caminho de busca. Uma transação faz um fsync para o lote inteiro.
   */
  function forgetMany(keys: string[], removeFromStore: (key: string) => boolean) {
    if (!keys.length) return;
    // L1 é a fonte das leituras. A limpeza precisa valer mesmo quando o SQLite
    // não existe; o L2 é apenas a cópia best-effort para sobreviver ao restart.
    for (const key of keys) {
      removeFromStore(key);
      pending.delete(key);
    }
    if (!db || !deleteStmt) return;
    try {
      db.exec('BEGIN');
      try {
        for (const key of keys) deleteStmt.run(key);
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignora falha de rollback se a transação já foi abortada */
        }
        throw err;
      }
    } catch (err) {
      /* idem: o TTL em memória já protege a leitura */
      log.warn('[cache] falha ao podar o disco:', err.message);
    }
  }

  /** Trunca o L2 inteiro; o chamador zera L1 e fila pendente antes. */
  function clearDisk() {
    if (!clearStmt) return;
    try {
      clearStmt.run();
    } catch {
      /* idem */
    }
  }

  let lastMaintainAt = 0;
  const MAINTAIN_MIN_INTERVAL_MS = 15 * 60 * 1000;

  /**
   * Rotina periódica de manutenção do SQLite, chamada em momentos ociosos
   * (ex: tick do colhedor):
   * 1. PRAGMA wal_checkpoint(PASSIVE): transfere páginas do WAL para o DB sem travar leitores/escritores.
   * 2. PRAGMA optimize: atualiza estatísticas do query planner do SQLite.
   * 3. PRAGMA freelist_count: mede páginas livres que serão reutilizadas pelo SQLite.
   */
  function maintain(force = false): { checkpointed: boolean; optimized: boolean; vacuumed: boolean; freelistCount: number } {
    if (!db) return { checkpointed: false, optimized: false, vacuumed: false, freelistCount: 0 };
    const now = Date.now();
    if (!force && lastMaintainAt > 0 && now - lastMaintainAt < MAINTAIN_MIN_INTERVAL_MS) {
      return { checkpointed: false, optimized: false, vacuumed: false, freelistCount: 0 };
    }
    lastMaintainAt = now;
    let checkpointed = false;
    let optimized = false;
    let freelistCount = 0;

    try {
      flushPending();
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      checkpointed = true;
      db.exec('PRAGMA optimize');
      optimized = true;

      // Freelist: páginas liberadas após deletes/expirações reutilizadas nas próximas inserções
      const row = db.prepare('PRAGMA freelist_count').get() as any;
      freelistCount = Number(row?.freelist_count ?? row?.[0] ?? 0) || 0;
    } catch (err: unknown) {
      log.warn('[cache] manutenção do SQLite falhou:', log.errorMessage(err));
    }

    return { checkpointed, optimized, vacuumed: false, freelistCount };
  }

  /** Libera o L2 no encerramento; o L1 continua utilizável até o processo sair. */
  function close() {
    if (flushScheduled) {
      clearImmediate(flushScheduled);
      flushScheduled = null;
    }
    if (!db) return;
    try {
      // Despeja o lote do tick corrente antes de fechar: no shutdown limpo o
      // adiamento não precisa custar uma busca a mais depois do restart.
      flushPending();
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      log.warn('[cache] falha ao fechar persistência:', err.message);
    } finally {
      db = null;
      insertStmt = null;
      deleteStmt = null;
      deleteExpiredStmt = null;
      deleteStaleStmt = null;
      deleteLegacyStmt = null;
      clearStmt = null;
    }
  }

  /** Estatísticas O(1) de disco do L2 SQLite (sem scans, não-bloqueante). */
  function l2Stats() {
    let fileSizeBytes = 0;
    let walSizeBytes = 0;
    let freelistCount = 0;
    if (config.cache.persist) {
      try {
        if (fs.existsSync(DB_PATH)) fileSizeBytes = fs.statSync(DB_PATH).size;
      } catch {
        fileSizeBytes = 0;
      }
      try {
        const walPath = `${DB_PATH}-wal`;
        if (fs.existsSync(walPath)) walSizeBytes = fs.statSync(walPath).size;
      } catch {
        walSizeBytes = 0;
      }
      if (db) {
        try {
          const row = db.prepare('PRAGMA freelist_count').get() as any;
          freelistCount = Number(row?.freelist_count ?? row?.[0] ?? 0) || 0;
        } catch {
          freelistCount = 0;
        }
      }
    }
    // UM nome por número. `freelistCount` é o mesmo termo que `maintain()` já
    // devolve para este PRAGMA, e `pendingWrites` diz o que a fila é; expor
    // apelidos do mesmo valor só cria dois campos para editar em lugares
    // diferentes na próxima mudança.
    //
    // `_origem` porque os quatro não têm a mesma procedência: tamanho, WAL e
    // freelist são medidos do disco agora; a fila pendente é estado deste
    // processo e zera no restart. Sem o rótulo o painel mostra os dois com a
    // mesma cara de medido.
    return {
      enabled: Boolean(config.cache.persist && db),
      fileSizeBytes,
      walSizeBytes,
      freelistCount,
      pendingWrites: pending.size,
      _origem: {
        enabled: 'duravel',
        fileSizeBytes: 'duravel',
        walSizeBytes: 'duravel',
        freelistCount: 'duravel',
        pendingWrites: 'amostra',
      } as const,
    };
  }

  return {
    open, pruneOnBoot, persist, pending, forget, forgetMany,
    clearDisk, maintain, close, maxGraceMs, l2Stats,
  };
}

