/**
 * Camada de abertura e persistência SQLite do cache multi-nível. Memória é o
 * L1; o SQLite só existe pra sobreviver ao restart do container. Sem ele o
 * addon funciona igual, só volta a esquentar do zero a cada subida.
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
import * as metrics from './metrics.js';
import { NAMESPACE_VERSIONS, LEGACY_PREFIXES } from './cache-keys.js';
import { MAX_ENTRIES, namespaceFor, quotaFor } from './cache-quotas.js';
import { openWithRecovery } from './cache-db-open.js';

/** Pontos de contato com o L1, dono do store (cache.ts fornece as amarras). */
export interface CacheDbHooks {
  store: Map<string, any>;
  removeFromStore(key: string): boolean;
  incrementNamespace(namespace: string): void;
}

export function createPersistence() {
  const DB_PATH = config.cache.dbPath;
  let db: any = null;
  let insertStmt: any = null;
  let deleteStmt: any = null;
  let deleteExpiredStmt: any = null;
  let deleteStaleStmt: any = null;
  let deleteLegacyStmt: any = null;
  let selectIndexStmt: any = null;
  let selectValueStmt: any = null;
  let clearStmt: any = null;

  // Escrita em LOTE: antes cada cache.set pagava um INSERT síncrono (commit no
  // WAL) no caminho de busca, e o passe tardio gravava várias chaves em
  // sequência. A chave é marcada aqui e despejada no próximo tick numa transação
  // só — mesmo racional do forgetMany. Queda do processo perde só o lote do tick
  // corrente: aceitável porque o L2 é best-effort e o passe tardio reconstrói o
  // resultado na busca seguinte.
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
      deleteExpiredStmt = database.prepare('DELETE FROM cache WHERE expires_at <= ?');
      // Descarte de versão obsoleta: apaga no banco o que não bate com a versão
      // corrente, sem materializar a linha. `<ns>:%` + NOT LIKE da versão viva
      // cobre tanto o formato `<ns>:<versão>:` quanto prefixos colados no nome.
      deleteStaleStmt = database.prepare('DELETE FROM cache WHERE key LIKE ? AND key NOT LIKE ?');
      deleteLegacyStmt = database.prepare('DELETE FROM cache WHERE key LIKE ?');
      // Índice leve: decide QUEM sobe sem trazer os valores gordos junto. Um LIMIT
      // global trocaria o problema de memória por um de correção (dlmag de TTL
      // longo consumiria o corte e empurraria streams para fora), então o valor é
      // buscado por PK só para as chaves que passaram na cota.
      selectIndexStmt = database.prepare('SELECT key, expires_at FROM cache ORDER BY expires_at DESC');
      selectValueStmt = database.prepare('SELECT value FROM cache WHERE key = ?');
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
      selectIndexStmt = null;
      selectValueStmt = null;
      clearStmt = null;
      return null;
    }
  }

  /**
   * Máxima janela de graça entre os consumidores do cache. Hoje só as listas de
   * stream usam (SWR); prune/loadFromDisk precisam respeitá-la, senão o timer de
   * 10 min apaga a entrada expirada antes de o refresh de fundo poder servi-la.
   */
  function maxGraceMs() {
    return Math.max(0, config.streamStaleGrace) * 1000;
  }

  /** Sobe o que ainda é válido; o que expirou enquanto estava fora, morre aqui. */
  function loadFromDisk(hooks: CacheDbHooks) {
    const { store, removeFromStore, incrementNamespace } = hooks;
    if (!db || !selectIndexStmt || !selectValueStmt || !deleteExpiredStmt || !deleteStaleStmt || !deleteLegacyStmt) return;
    try {
      const now = Date.now();
      // Expirado DENTRO da janela de graça sobe junto: ele ainda é servível pelo
      // SWR. Sem deslocar o corte, todo restart matava as entradas em revalidação.
      deleteExpiredStmt.run(now - maxGraceMs());
      // Versão de namespace é fonte única (cache-keys.js): apaga no banco, ANTES de
      // listar, tudo que não bate com a versão corrente — é mais barato apagar do
      // que carregar para descartar em JS, e a versão morta não ocupa cota até
      // expirar. Prefixos aposentados (raw1:/dinv1:) somem do mesmo jeito no boot.
      for (const [ns, version] of Object.entries(NAMESPACE_VERSIONS)) {
        deleteStaleStmt.run(`${ns}:%`, `${ns}:${version}:%`);
      }
      for (const legacy of LEGACY_PREFIXES) deleteLegacyStmt.run(`${legacy}%`);
      // TTL longo não pode monopolizar o L1 depois do restart: cada namespace
      // recebe o próprio orçamento antes da ordem de recência ser reconstruída.
      const rows = selectIndexStmt.all();
      const selected: { key: any; value: any; expiresAt: number; namespace: string }[] = [];
      const selectedCounts = new Map();
      const skipped: any[] = [];
      const quotaSkipped: any[] = [];
      for (const row of rows) {
        const namespace = namespaceFor(row.key);
        if ((selectedCounts.get(namespace) || 0) >= quotaFor(namespace) || selected.length >= MAX_ENTRIES) {
          skipped.push(row.key);
          quotaSkipped.push(row.key);
          continue;
        }
        try {
          // O valor gordo só é trazido para quem passou na cota (busca por PK).
          const valueRow = selectValueStmt.get(row.key);
          // Sumiu entre a listagem e a busca do valor: acontece quando outro
          // processo divide o mesmo cache.db (container + instância de teste).
          // Não é registro corrompido — só não existe mais.
          if (!valueRow) {
            skipped.push(row.key);
            continue;
          }
          selected.push({
            key: row.key,
            value: JSON.parse(valueRow.value),
            expiresAt: Number(row.expires_at),
            namespace,
          });
          selectedCounts.set(namespace, (selectedCounts.get(namespace) || 0) + 1);
        } catch (rowErr) {
          log.warn(`[cache] registro corrompido ignorado para chave '${row.key}':`, rowErr.message);
          skipped.push(row.key);
        }
      }
      // A seleção vem do TTL mais longo para o mais curto. Inserir ao contrário
      // deixa o menor TTL selecionado como LRU dentro de cada namespace.
      let loaded = 0;
      for (const entry of selected.reverse()) {
        store.set(entry.key, entry);
        incrementNamespace(entry.namespace);
        loaded++;
      }
      // Entradas acima da cota nunca voltariam a caber neste processo; removê-las
      // evita revarrer o mesmo banco dominado no próximo restart.
      for (const key of quotaSkipped) {
        metrics.count('cache.evicted.quota');
        metrics.count(`cache.evicted.quota.${namespaceFor(key)}`);
      }
      forgetMany(skipped, removeFromStore);
      if (loaded) log.info(`[cache] ${loaded} entrada(s) recuperada(s) do disco`);
    } catch (err) {
      log.warn('[cache] falha ao ler o cache do disco:', err.message);
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

  /**
   * Rotina periódica de manutenção do SQLite, chamada em momentos ociosos
   * (ex: tick do colhedor):
   * 1. PRAGMA wal_checkpoint(PASSIVE): transfere páginas do WAL para o DB sem travar leitores/escritores.
   * 2. PRAGMA optimize: atualiza estatísticas do query planner do SQLite.
   * 3. PRAGMA freelist_count: se houver páginas livres acumuladas (> 500 páginas, ~2 MB), executa VACUUM.
   */
  function maintain(): { checkpointed: boolean; optimized: boolean; vacuumed: boolean; freelistCount: number } {
    if (!db) return { checkpointed: false, optimized: false, vacuumed: false, freelistCount: 0 };
    let checkpointed = false;
    let optimized = false;
    let vacuumed = false;
    let freelistCount = 0;

    try {
      flushPending();
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      checkpointed = true;
      db.exec('PRAGMA optimize');
      optimized = true;

      // Freelist: páginas liberadas após deletes/expirações que ainda não foram reutilizadas
      const row = db.prepare('PRAGMA freelist_count').get() as any;
      freelistCount = Number(row?.freelist_count ?? row?.[0] ?? 0) || 0;

      // Limiar: 500 páginas (tamanho padrão de página 4096 = ~2 MB de espaço ocioso)
      if (freelistCount > 500) {
        log.info(`[cache] freelist_count atingiu ${freelistCount} páginas; executando VACUUM`);
        db.exec('VACUUM');
        vacuumed = true;
      }
    } catch (err: unknown) {
      log.warn('[cache] manutenção do SQLite falhou:', log.errorMessage(err));
    }

    return { checkpointed, optimized, vacuumed, freelistCount };
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
      selectIndexStmt = null;
      selectValueStmt = null;
      clearStmt = null;
    }
  }

  return {
    open, loadFromDisk, persist, pending, forget, forgetMany,
    clearDisk, maintain, close, maxGraceMs,
  };
}
