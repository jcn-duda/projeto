// Cartão de AJUSTE POR SITE da aba Raspagens (Fase 8 multi-site). O topo da aba
// tem a `LiveConfigCard` (schema do backend, knobs GLOBAIS); aqui o ajuste é do
// site: `crawl-config-set { site, patch }` grava o override daquele site e
// `crawl-config-reset { site, confirm }` o apaga. Sem `site` nenhuma das duas é
// chamada — o global é do cartão de cima.
//
// Duas camadas, como o resto do painel: `SiteConfigForm` é PURA (renderiza,
// calcula o delta, avisa) e é o que o teste chama direto; `SiteConfigCard` só
// guarda o estado do formulário e ressincroniza quando o poll traz o override
// novo. Nenhuma delas chama `fetch` — o POST é injetado pela casca.
import { html, useState, useEffect } from './vendor/preact.js';
import { Card } from './kit.js';
import { ToggleField, NumberField, Button, FormActions } from './form.js';
import {
  clampSiteNumber,
  globalOverride,
  overrideKey,
  siteConfigDiff,
  siteConfigHint,
  siteFormOf,
  type SiteConfigForm,
} from './raspagens-site.js';
import type { CrawlSummary, CrawlSiteCard } from './raspagens-model.js';

export interface SiteConfigFormProps {
  card: CrawlSiteCard;
  summary: CrawlSummary;
  form: SiteConfigForm;
  pending: boolean;
  onChange: (next: SiteConfigForm) => void;
  onApply: (patch: Partial<SiteConfigForm>) => void;
  onDiscard: () => void;
  onReset: () => void;
}

/** Formulário do override: 4 campos, o delta e as três ações. O botão de
 * aplicar nasce desabilitado — POST sem mudança não existe (mesma regra do
 * `LiveConfigCard` do topo). */
export function SiteConfigForm(props: SiteConfigFormProps) {
  const { card, summary, form, pending, onChange, onApply, onDiscard, onReset } = props;
  const base = globalOverride(summary);
  const { patch, changedKeys } = siteConfigDiff(form, card.override);
  // O selo "ao vivo" é por CAMPO: o que diverge do global e o que o operador
  // ajustou agora não podem virar a mesma marca.
  const isOwn = (key: string) => card.override.overridden.includes(key);
  const live = (key: string) => (isOwn(key) ? undefined : 'herdado do global');
  const liveBadge = (key: string) =>
    isOwn(key) ? html`<span class="painel-badge painel-badge-warn">ao vivo</span>` : null;

  return html`
    <${Card} title=${'Ajuste do site ' + card.id} badge=${siteConfigBadge(changedKeys.length, card.override.overridden.length)}>
      <div class="painel-form-row painel-form-grid">
        <div class="painel-config-field">
          ${liveBadge('enabled')}
          <${ToggleField}
            label="Raspagem deste site"
            checked=${form.enabled}
            disabled=${pending}
            hint=${live('enabled')}
            onChange=${(next: boolean) => onChange({ ...form, enabled: next })}
          />
        </div>
        <div class="painel-config-field">
          ${liveBadge('dryRun')}
          <${ToggleField}
            label="Modo simulação deste site"
            checked=${form.dryRun}
            disabled=${pending}
            hint=${live('dryRun')}
            onChange=${(next: boolean) => onChange({ ...form, dryRun: next })}
          />
        </div>
        <div class="painel-config-field">
          ${liveBadge('delayMs')}
          <${NumberField}
            label="Pausa entre páginas (ms)"
            value=${form.delayMs}
            min=${0}
            max=${60000}
            step=${500}
            disabled=${pending}
            hint=${live('delayMs')}
            onChange=${(next: number) => onChange({ ...form, delayMs: clampSiteNumber('delayMs', next) })}
          />
        </div>
        <div class="painel-config-field">
          ${liveBadge('maxPerHour')}
          <${NumberField}
            label="Teto de requisições por hora"
            value=${form.maxPerHour}
            min=${1}
            max=${20000}
            step=${100}
            disabled=${pending}
            hint=${live('maxPerHour')}
            onChange=${(next: number) => onChange({ ...form, maxPerHour: clampSiteNumber('maxPerHour', next) })}
          />
        </div>
      </div>

      <p class="painel-field-hint">${siteConfigHint(card.override, base)}</p>

      <${FormActions}>
        <${Button}
          variant="accent"
          pending=${pending}
          disabled=${changedKeys.length === 0}
          onClick=${() => onApply(patch)}
        >
          Aplicar no site${changedKeys.length > 0 ? ' (' + changedKeys.length + ')' : ''}
        </${Button}>
        <${Button} disabled=${pending || changedKeys.length === 0} onClick=${onDiscard}>Descartar</${Button}>
        <${Button} variant="danger" disabled=${pending} onClick=${onReset}>Voltar ao global</${Button}>
      </${FormActions}>
    </${Card}>
  `;
}

/** Badge do cartão. "N a aplicar" vem primeiro porque é o que trava o
 * formulário; o "ao vivo" diz o que já diverge do global do motor. */
function siteConfigBadge(
  changed: number,
  ownCount: number,
): { text: string; variant: 'ok' | 'warn' | 'neutral' } {
  if (changed > 0) return { text: changed + ' alteração(ões) a aplicar', variant: 'warn' };
  if (ownCount > 0) return { text: ownCount + ' campo(s) ao vivo', variant: 'warn' };
  return { text: 'herdado do global', variant: 'neutral' };
}

export interface SiteConfigCardProps {
  card: CrawlSiteCard;
  summary: CrawlSummary;
  pending: boolean;
  onApply: (patch: Partial<SiteConfigForm>) => void;
  onReset: () => void;
}

/** Casca com estado: guarda o formulário e o ressincroniza quando o poll traz
 * um override novo (sem isso o formulário "grudava" num valor velho e o
 * operador aplicaria por cima do que o motor já gravou). */
export function SiteConfigCard({ card, summary, pending, onApply, onReset }: SiteConfigCardProps) {
  const seed = overrideKey(card.override);
  const [form, setForm] = useState<SiteConfigForm>(siteFormOf(card.override));
  useEffect(() => {
    setForm(siteFormOf(card.override));
  }, [seed]);

  return html`
    <${SiteConfigForm}
      card=${card}
      summary=${summary}
      form=${form}
      pending=${pending}
      onChange=${setForm}
      onApply=${onApply}
      onDiscard=${() => setForm(siteFormOf(card.override))}
      onReset=${onReset}
    />
  `;
}
