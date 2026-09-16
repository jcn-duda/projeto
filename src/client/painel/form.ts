import { html } from './vendor/preact.js';

/** Controles PUROS da base interativa do painel: sem estado próprio — o valor e
 * o callback vêm de fora. É o contrato que a configuração ao vivo reaproveita
 * (formulário controlado) sem cada tela inventar input + rótulo + dica. */

export interface Option {
  value: string;
  label: string;
}

export interface FieldProps {
  label: string;
  hint?: string;
  children?: any;
}

/** Rótulo + controle + dica, com o espaçamento do formulário. */
export function Field({ label, hint, children }: FieldProps) {
  return html`
    <label class="painel-field">
      <span class="painel-field-label">${label}</span>
      ${children}
      ${hint ? html`<span class="painel-field-hint">${hint}</span>` : null}
    </label>
  `;
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
}

export function TextField({ label, value, onChange, type = 'text', placeholder, hint, disabled }: TextFieldProps) {
  return html`
    <${Field} label=${label} hint=${hint}>
      <input
        class="painel-input"
        type=${type}
        value=${value}
        placeholder=${placeholder}
        disabled=${disabled}
        onInput=${(e: any) => onChange(e.target.value)}
      />
    </${Field}>
  `;
}

export interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  disabled?: boolean;
}

/** Campo numérico: emite só número FINITO. Entrada vazia/inválida é ignorada em
 * vez de virar 0 silenciosamente — 0 é escolha válida em vários clamps. */
export function NumberField({ label, value, onChange, min, max, step, hint, disabled }: NumberFieldProps) {
  const onInput = (e: any) => {
    const raw = e.target.value;
    const parsed = Number(raw);
    if (raw === '' || !Number.isFinite(parsed)) return;
    onChange(parsed);
  };
  return html`
    <${Field} label=${label} hint=${hint}>
      <input
        class="painel-input"
        type="number"
        value=${value}
        min=${min}
        max=${max}
        step=${step}
        disabled=${disabled}
        onInput=${onInput}
      />
    </${Field}>
  `;
}

export interface SelectFieldProps {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  hint?: string;
  disabled?: boolean;
}

export function SelectField({ label, value, options, onChange, hint, disabled }: SelectFieldProps) {
  return html`
    <${Field} label=${label} hint=${hint}>
      <select class="painel-select" value=${value} disabled=${disabled} onChange=${(e: any) => onChange(e.target.value)}>
        ${options.map((option) => html`<option key=${option.value} value=${option.value}>${option.label}</option>`)}
      </select>
    </${Field}>
  `;
}

export interface ToggleFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
}

export function ToggleField({ label, checked, onChange, hint, disabled }: ToggleFieldProps) {
  return html`
    <label class="painel-field">
      <span class="painel-check">
        <input
          type="checkbox"
          checked=${checked}
          disabled=${disabled}
          onChange=${(e: any) => onChange(Boolean(e.target.checked))}
        />
        <span class="painel-field-label">${label}</span>
      </span>
      ${hint ? html`<span class="painel-field-hint">${hint}</span>` : null}
    </label>
  `;
}

export interface ButtonProps {
  children?: any;
  variant?: 'default' | 'accent' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
  pending?: boolean;
  onClick?: () => void;
}

/** Botão da base: variante + estado pendente que desabilita o clique. */
export function Button({ children, variant = 'default', type = 'button', disabled, pending, onClick }: ButtonProps) {
  const variantClass =
    variant === 'accent' ? ' painel-btn-accent' : variant === 'danger' ? ' painel-btn-danger' : '';
  return html`
    <button type=${type} class=${'painel-btn' + variantClass} disabled=${Boolean(disabled || pending)} onClick=${onClick}>
      ${children}
    </button>
  `;
}

export interface FormActionsProps {
  children?: any;
}

/** Fileira de ações do formulário (mesmo `.painel-btn-row` das views). */
export function FormActions({ children }: FormActionsProps) {
  return html`<div class="painel-btn-row">${children}</div>`;
}
