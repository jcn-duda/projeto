import { html, useState, useEffect, useRef } from './vendor/preact.js';
import { Card } from './kit.js';
import { useAction, actionError, actionFailure } from './action.js';
import { SelectField, TextField, Button, FormActions } from './form.js';
import { getPainelState } from './store.js';

/**
 * Conta de debrid de FUNDO do Colhedor (quota-warn e aquecimento RD). Extraído
 * de view-colhedor.ts pela catraca de 400 linhas.
 *
 * Segurança: a chave crua NUNCA é exibida. O snapshot do backend só traz
 * `last4`/`fingerprint`, o input é `type="password"` e é limpo em todo desfecho
 * (testar/salvar/restaurar). Gravar exige RESOLVE_SECRET no servidor (a chave é
 * cifrada no SQLite); sem ele, o 400 traz `reason`/`fix` e a tela mostra o
 * motivo — por isso `postAction` preserva o corpo do erro.
 */

/** Motivos do backend para a conta não ser salva (mesmo mapa do dashboard
 * legado, harvest-debrid.ts): o 400 do `set` traz `reason`/`fix`. */
const HB_REASON_LABELS: Record<string, string> = {
  resolve_secret_required: 'RESOLVE_SECRET ausente no .env',
  'chave-operador-desativada': 'conta de operador desativada no .env',
  'servico-desconhecido': 'serviço desconhecido',
  'chave-invalida': 'chave inválida',
};

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

/** Rótulo do serviço vem do bloco `debrid` do status (backend manda id+label).
 * Sem o bloco, o próprio id é a resposta honesta — nunca inventa nome. */
function serviceLabel(id: string): string {
  const services = getPainelState().payload?.debrid?.services;
  if (Array.isArray(services)) {
    for (const service of services) {
      if (service && service.id === id && typeof service.label === 'string' && service.label) return service.label;
    }
  }
  return id;
}

/** Opções do seletor: capacidades do snapshot (fonte da verdade) somadas aos
 * serviços do status, deduplicados — sem lista hardcoded de serviços. */
function serviceCatalog(snapshot: Record<string, any> | null): Array<{ value: string; label: string }> {
  const ids = new Set<string>();
  const caps = asObject(snapshot?.capabilitiesByService);
  if (caps) for (const id of Object.keys(caps)) ids.add(id);
  const services = getPainelState().payload?.debrid?.services;
  if (Array.isArray(services)) {
    for (const service of services) {
      if (service && typeof service.id === 'string' && service.id) ids.add(service.id);
    }
  }
  return [...ids].map((id) => ({ value: id, label: serviceLabel(id) }));
}

function debridSourceLabel(source: unknown): string {
  if (source === 'panel') return 'painel (override)';
  if (source === 'env') return '.env';
  return 'nenhuma conta';
}

function reasonText(reason: unknown): string {
  const key = String(reason || '');
  return HB_REASON_LABELS[key] || key;
}

export interface HarvesterDebridCardProps {
  /** Snapshot do bloco `harvest` (semeia a tela antes do GET sob demanda). */
  account?: Record<string, any>;
  resolved?: string | null;
}

export function HarvesterDebridCard({ account, resolved }: HarvesterDebridCardProps) {
  const [snapshot, setSnapshot] = useState<Record<string, any> | null>(asObject(account));
  const [service, setService] = useState<string>(typeof account?.service === 'string' ? account.service : '');
  const [keyInput, setKeyInput] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const serviceSynced = useRef(Boolean(account?.service));
  const { pending, run } = useAction();

  const applyConfig = (config: unknown) => {
    const next = asObject(config);
    if (!next) return;
    setSnapshot(next);
    // Só abre o select no serviço da conta atual UMA vez; depois é escolha do
    // operador e o polling não pode brigar com a seleção em andamento.
    if (!serviceSynced.current && typeof next.service === 'string' && next.service) {
      setService(next.service);
      serviceSynced.current = true;
    }
  };

  const refresh = async () => {
    setFeedback(null);
    const outcome = await run({
      action: 'harvester-debrid-get',
      failureFallback: 'não foi possível ler a conta de fundo',
    });
    if (outcome.ok) {
      applyConfig(outcome.data.config);
      return;
    }
    const error = actionError(outcome);
    if (error) setFeedback({ text: `Falha ao ler a conta: ${error}`, ok: false });
  };

  // Sob demanda: lê quando a aba monta; o bloco `harvest` do poll é só a semente.
  useEffect(() => {
    void refresh();
  }, []);

  const testKey = async () => {
    const chosen = service.trim();
    const key = keyInput.trim();
    if (!chosen) {
      setFeedback({ text: 'Escolha o serviço da conta.', ok: false });
      return;
    }
    if (!key) {
      setFeedback({ text: 'Cole a chave de API para testar.', ok: false });
      return;
    }
    const outcome = await run({
      action: 'debrid-account-test',
      body: { service: chosen, key },
      failureFallback: 'teste não concluído',
    });
    setKeyInput('');
    if (!outcome.ok) {
      const detail = actionFailure(outcome);
      const motivo = reasonText(detail?.reason) || detail?.errors.join(' ') || actionError(outcome) || 'motivo desconhecido';
      const fix = detail?.fix ? ' Como corrigir: ' + detail.fix : '';
      setFeedback({ text: 'Teste não concluído: ' + motivo + '.' + fix, ok: false });
      return;
    }
    const data = outcome.data;
    if (data.ok) {
      setFeedback({ text: 'Chave aceita pelo serviço.', ok: true });
    } else {
      const motivo = reasonText(data.reason) || String(data.message || data.error || 'motivo desconhecido');
      setFeedback({ text: 'Teste sem sucesso: ' + motivo, ok: false });
    }
  };

  const saveAccount = async () => {
    const chosen = service.trim();
    const key = keyInput.trim();
    if (!chosen) {
      setFeedback({ text: 'Escolha o serviço da conta.', ok: false });
      return;
    }
    if (!key) {
      setFeedback({ text: 'Cole a chave de API, ou use Restaurar .env.', ok: false });
      return;
    }
    const outcome = await run({
      action: 'harvester-debrid-set',
      body: { service: chosen, key },
      poll: ['harvest'],
      successToast: 'Conta de fundo do Colhedor salva',
      failureFallback: 'conta não salva',
    });
    setKeyInput('');
    if (outcome.ok) {
      applyConfig(outcome.data.config);
      setFeedback({ text: 'Conta salva: a chave foi cifrada e não volta à tela.', ok: true });
      return;
    }
    const detail = actionFailure(outcome);
    const reason = reasonText(detail?.reason) || detail?.errors.join(' ') || actionError(outcome) || 'erro';
    const fix = detail?.fix ? ' Como corrigir: ' + detail.fix : '';
    setFeedback({ text: `Conta não salva — ${reason}.${fix}`, ok: false });
  };

  const restoreEnv = async () => {
    const outcome = await run({
      action: 'harvester-debrid-set',
      body: { service: service.trim(), key: '' },
      // Remover o override é irreversível: confirma no modal real.
      confirm: {
        title: 'Restaurar conta do Colhedor',
        message: 'Restaurar a conta de debrid de fundo ao .env?',
        detail: 'O override salvo no painel será removido e quota-warn/aquecimento RD voltam a usar a conta do .env.',
        confirmLabel: 'Restaurar .env',
        danger: true,
      },
      poll: ['harvest'],
      successToast: 'Conta restaurada do .env',
      failureFallback: 'não foi possível restaurar a conta',
    });
    if (outcome.ok) {
      applyConfig(outcome.data.config);
      setFeedback({ text: 'Conta restaurada do .env; o override do painel foi removido.', ok: true });
      return;
    }
    const detail = actionFailure(outcome);
    const motivo = reasonText(detail?.reason) || detail?.errors.join(' ') || actionError(outcome) || 'erro';
    const fix = detail?.fix ? ' Como corrigir: ' + detail.fix : '';
    setFeedback({ text: `Falha ao restaurar: ${motivo}.${fix}`, ok: false });
  };

  const conta = snapshot || {};
  const caps = asObject(conta.capabilities) || {};
  const options = serviceCatalog(snapshot);
  const badge = conta.sealBroken
    ? { text: 'SELO QUEBRADO', variant: 'err' as const }
    : conta.source === 'panel'
      ? { text: 'OVERRIDE DO PAINEL', variant: 'warn' as const }
      : conta.source === 'env'
        ? { text: '.ENV', variant: 'ok' as const }
        : { text: 'SEM CONTA', variant: 'neutral' as const };

  return html`
    <${Card} title="Conta de Debrid do Colhedor" badge=${badge}>
      ${feedback
        ? html`<div class="painel-feedback ${feedback.ok ? 'painel-feedback-ok' : 'painel-feedback-err'}">${feedback.text}</div>`
        : null}

      ${conta.sealBroken
        ? html`
            <div class="painel-feedback painel-feedback-err">
              A conta do painel está gravada, mas a chave não abre (RESOLVE_SECRET alterado). Quota-warn e aquecimento RD estão DESLIGADOS: restaure o .env ou salve a chave novamente.
            </div>
          `
        : null}

      <table class="painel-table">
        <tbody>
          <tr><td>Origem</td><td>${debridSourceLabel(conta.source)}</td></tr>
          <tr><td>Serviço</td><td>${conta.service ? serviceLabel(String(conta.service)) : '—'}</td></tr>
          <tr><td>Chave</td><td>${conta.keySet ? '•••• ' + String(conta.last4 || '') : 'não definida'}</td></tr>
          <tr><td>Impressão digital</td><td><code>${conta.fingerprint || '—'}</code></td></tr>
          <tr><td>Gravada</td><td>${conta.source === 'panel' && conta.updatedAt ? new Date(conta.updatedAt).toLocaleString() : '—'}</td></tr>
          <tr><td>quota-warn</td><td>${caps.quotaWarn === true ? 'sim' : 'não'}</td></tr>
          <tr><td>aquecimento RD</td><td>${caps.brWarm === true ? 'sim' : 'não'}</td></tr>
          <tr><td>Quota-warn usa</td><td>${resolved ? serviceLabel(String(resolved)) : '—'}</td></tr>
        </tbody>
      </table>

      <div class="painel-form-row" style="margin-top: var(--space-3);">
        <${SelectField}
          label="Serviço"
          value=${service}
          options=${options}
          disabled=${pending}
          hint="Serviços derivados do registry e do status."
          onChange=${setService}
        />
        <${TextField}
          label="Chave de API"
          type="password"
          value=${keyInput}
          disabled=${pending}
          placeholder="cole a chave (não é exibida depois de salvar)"
          hint="A chave nunca é exibida de volta: fica cifrada no SQLite."
          onChange=${setKeyInput}
        />
      </div>

      <${FormActions}>
        <${Button} pending=${pending} onClick=${() => { void testKey(); }}>Testar chave</${Button}>
        <${Button} variant="accent" pending=${pending} disabled=${!keyInput.trim()} onClick=${() => { void saveAccount(); }}>Salvar conta</${Button}>
        <${Button} variant="danger" pending=${pending} onClick=${() => { void restoreEnv(); }}>Restaurar .env</${Button}>
        <${Button} pending=${pending} onClick=${() => { void refresh(); }}>Atualizar</${Button}>
      </${FormActions}>
    </${Card}>
  `;
}
