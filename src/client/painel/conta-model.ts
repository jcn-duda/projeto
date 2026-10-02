/**
 * Modelo puro da aba Conta.
 *
 * O bloco `conta` do backend descreve a conta da REQUISIÇÃO: painel aberto na
 * raiz não carrega serviço nem chave, então ele volta zerado com
 * `debrid.account.reason = "sem-debrid"`. A view antiga lia só esse bloco e
 * caía no `?? 0`, pintando "0 / 1000 (0%)" com badge verde — indistinguível de
 * uma conta limpa, enquanto a conta do operador estava a 86% do teto.
 *
 * Duas coisas separadas, então, e as duas visíveis:
 *
 * 1. A ORIGEM do número (`instalacao` | `operador` | `ausente`). `sem-debrid`
 *    é escolha de configuração, não falha — mesma leitura de `debridInfo` em
 *    [saude-model.ts](./saude-model.ts).
 * 2. O número em si. Sem conta na requisição, `debrid.accounts` ainda traz a
 *    conta que o servidor mede pelo `.env`; mostrá-la (rotulada como do
 *    operador) é melhor que mostrar zero, porque é o dado que o operador abriu
 *    o painel para ver.
 */
import type { BadgeVariant } from './kit.js';

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

export type ContaOrigem = 'instalacao' | 'operador' | 'ausente';

export interface ContaView {
  origem: ContaOrigem;
  /** Serviço medido ("alldebrid"), ou "" quando não há conta nenhuma. */
  service: string;
  label: string;
  total: number;
  ready: number;
  downloading: number;
  dead: number;
  cap: number;
  warnAt: number;
  percent: number;
  oldestAt: number | null;
  badge: { text: string; variant: BadgeVariant };
  /** Nota de origem, ou "" quando o número é da própria instalação. */
  nota: string;
}

const CAP_PADRAO = 1000;
const WARN_PADRAO = 800;

/**
 * Conta do operador viva no servidor. Com mais de uma, prefere a do serviço
 * ativo — `debrid.active` é o que o `.env` escolheu, e é dele que sai a
 * varredura periódica; cair na primeira chave do objeto faria o painel mostrar
 * uma conta que nenhuma rotina toca.
 */
function contaDoOperador(debrid: Record<string, any>): { id: string; entry: Record<string, any> } | null {
  const accounts = asObject(debrid.accounts) || {};
  const ativo = String(debrid.active || '');
  const vivas = Object.keys(accounts)
    .map((id) => ({ id, entry: asObject(accounts[id]) || {} }))
    .filter((item) => item.entry.ok === true);

  if (vivas.length === 0) return null;
  return vivas.find((item) => item.id === ativo) || vivas[0];
}

function variantePorUso(percent: number, warn: boolean): BadgeVariant {
  if (percent >= 90) return 'err';
  if (percent >= 80 || warn) return 'warn';
  return 'ok';
}

export function contaView(conta: unknown, debrid: unknown): ContaView {
  const c = asObject(conta) || {};
  const d = asObject(debrid) || {};
  const cap = Number(c.cap) > 0 ? Number(c.cap) : CAP_PADRAO;

  const vazio: ContaView = {
    origem: 'ausente',
    service: '',
    label: '',
    total: 0,
    ready: 0,
    downloading: 0,
    dead: 0,
    cap,
    warnAt: Number(c.warnAt) > 0 ? Number(c.warnAt) : WARN_PADRAO,
    percent: 0,
    oldestAt: null,
    badge: { text: 'SEM DEBRID', variant: 'neutral' },
    nota: 'Nenhuma conta de debrid nesta requisição. Abra o painel pela sua URL de instalação para ver a sua conta.',
  };

  if (c.ok === true) {
    const total = Number(c.total || 0);
    const warnAt = Number(c.warnAt) > 0 ? Number(c.warnAt) : WARN_PADRAO;
    const percent = Number.isFinite(Number(c.usagePercent))
      ? Number(c.usagePercent)
      : cap > 0 ? Math.round((total / cap) * 100) : 0;
    return {
      origem: 'instalacao',
      service: String(c.service || ''),
      label: String(c.label || c.service || ''),
      total,
      ready: Number(c.ready || 0),
      downloading: Number(c.downloading || 0),
      dead: Number(c.dead || 0),
      cap,
      warnAt,
      percent,
      oldestAt: Number(c.oldestAt) > 0 ? Number(c.oldestAt) : null,
      badge: {
        text: `${percent}% DA CONTA`,
        variant: variantePorUso(percent, total >= warnAt),
      },
      nota: '',
    };
  }

  const operador = contaDoOperador(d);
  if (!operador) return vazio;

  const e = operador.entry;
  const total = Number(e.magnets || 0);
  const warnAt = Number(e.warnAt) > 0 ? Number(e.warnAt) : vazio.warnAt;
  const percent = cap > 0 ? Math.round((total / cap) * 100) : 0;
  const label = String(e.label || operador.id);

  return {
    origem: 'operador',
    service: String(e.service || operador.id),
    label,
    total,
    ready: Number(e.ready || 0),
    downloading: Number(e.active || 0),
    dead: Number(e.error || 0),
    cap,
    warnAt,
    percent,
    oldestAt: Number(e.oldestAt) > 0 ? Number(e.oldestAt) : null,
    badge: {
      text: `${percent}% DA CONTA`,
      variant: variantePorUso(percent, e.warn === true || total >= warnAt),
    },
    nota: `Conta do operador (${label}), medida no servidor — esta instalação não trouxe chave de debrid. Abra o painel pela sua URL de instalação para ver a sua.`,
  };
}
