import { html, useState, useEffect } from './vendor/preact.js';
import {
  getPainelState,
  subscribePainelState,
  subscribePainelToken,
  setPainelToken,
  type PainelState,
} from './store.js';
import { startPolling } from './poll.js';
import { ViewSaude } from './view-saude.js';
import { ViewConta } from './view-conta.js';
import { ViewGate } from './view-gate.js';
import { ViewColhedor } from './view-colhedor.js';
import { ViewSonda } from './view-sonda.js';
import { ViewChupim } from './view-chupim.js';
import { ViewCache } from './view-cache.js';
import { ViewLimpeza } from './view-limpeza.js';
import { ViewMagnets } from './view-magnets.js';
import { ViewDiagnostico } from './view-diagnostico.js';
import { ToastStack } from './toast.js';
import { ConfirmHost } from './confirm.js';
import { configFieldId } from './config-model.js';

export interface AppProps {
  initialTab?: string;
}

// A config ao vivo é lida sob demanda quando a aba monta: o `cfg-field` só
// existe depois da resposta. O foco tenta por ~6s e desiste — não trava a UI
// nem deixa o operador preso num alvo que nunca vai aparecer.
const FOCUS_RETRY_MS = 120;
const FOCUS_MAX_ATTEMPTS = 50;

// Contador de pedidos de foco: garante alvo novo a cada clique mesmo quando o
// campo é o mesmo (a `seq` é a dependência do efeito de foco).
let focusRequestSeq = 0;

/** Rola até o campo e move o foco para o controle (ou para o wrapper, que tem
 * tabindex=-1). O realce temporário dá o feedback visual do salto. */
function focusConfigField(element: HTMLElement): void {
  element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const control = element.querySelector<HTMLElement>('input, select, textarea, button');
  (control || element).focus();
  element.classList.add('painel-field-flash');
  window.setTimeout(() => element.classList.remove('painel-field-flash'), 1200);
}

// Abas válidas: o hash (`/painel#diagnostico`) abre direto na aba e o clique a
// atualiza — os atalhos legados apontam para `#chupim`/`#colhedor`. Hash fora
// da lista é ignorado (nunca troca a aba por um valor arbitrário da URL).
export const TAB_IDS = ['saude', 'conta', 'gate', 'colhedor', 'sonda', 'chupim', 'cache', 'limpeza', 'magnets', 'diagnostico'] as const;

export function tabFromHash(fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const raw = String(window.location?.hash || '').replace(/^#/, '').toLowerCase();
  return (TAB_IDS as readonly string[]).includes(raw) ? raw : fallback;
}

export function App(props: AppProps) {
  const [appState, setAppState] = useState<PainelState>(getPainelState());
  const [tokenInput, setTokenInput] = useState(appState.token);
  const initialTab = props.initialTab && (TAB_IDS as readonly string[]).includes(props.initialTab)
    ? props.initialTab
    : 'saude';
  const [activeTab, setActiveTab] = useState(tabFromHash(initialTab));
  const [focusRequest, setFocusRequest] = useState<{ id: string; seq: number } | null>(null);

  useEffect(() => {
    // Dois canais: o estado geral re-renderiza a página; o token só alimenta o
    // input quando o token PERSISTIDO muda. Ouvir o token no canal geral fazia
    // cada poll (loading/erro/merge) reescrever o input e apagar o que o
    // operador estava digitando.
    const unsubscribeState = subscribePainelState((next) => setAppState(next));
    const unsubscribeToken = subscribePainelToken((token) => setTokenInput(token));
    return () => {
      unsubscribeState();
      unsubscribeToken();
    };
  }, []);

  useEffect(() => {
    if (!appState.token) return;
    const stop = startPolling();
    return stop;
  }, [appState.token, appState.refreshRateS]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHashChange = () => setActiveTab((prev) => tabFromHash(prev));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const onSaveToken = () => {
    setPainelToken(tokenInput.trim());
  };

  const selectTab = (tab: string) => {
    setActiveTab(tab);
    if (typeof window !== 'undefined' && window.location?.hash !== `#${tab}`) {
      window.location.hash = tab;
    }
  };

  // Contrato de navegação gate → config ao vivo: troca a aba dona do campo,
  // atualiza o hash (rota VÁLIDA) e agenda o foco no `cfg-field`. O backend
  // manda o dono; sem ele o Chupim é o fallback (origem dos diffs do gate).
  const navigateToField = (key: string, owner: string | null) => {
    const tab = owner && (TAB_IDS as readonly string[]).includes(owner) ? owner : 'chupim';
    selectTab(tab);
    focusRequestSeq += 1;
    setFocusRequest({ id: configFieldId(key), seq: focusRequestSeq });
  };

  useEffect(() => {
    if (!focusRequest || typeof document === 'undefined') return;
    let cancelled = false;
    let attempts = 0;
    const tick = () => {
      if (cancelled) return;
      const element = document.getElementById(focusRequest.id);
      if (element) {
        focusConfigField(element);
        return;
      }
      if (attempts < FOCUS_MAX_ATTEMPTS) {
        attempts += 1;
        window.setTimeout(tick, FOCUS_RETRY_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [focusRequest]);

  const p = appState.payload || {};

  return html`
    <div class="painel-shell">
      <header class="painel-header">
        <div class="painel-brand">
          <img class="painel-logo" src="/logo.png" alt="Adom Logo" />
          <h1 class="painel-title">Adom Power-Movie</h1>
          <span class="painel-badge ${appState.connectionState === 'online' ? 'painel-badge-ok' : appState.connectionState === 'error' ? 'painel-badge-err' : 'painel-badge-neutral'}">
            ${appState.loading ? 'SINCRONIZANDO...' : appState.connectionState.toUpperCase()}
          </span>
        </div>
        <div class="painel-controls">
          <input
            type="password"
            class="painel-token-input"
            placeholder="Token operador..."
            value=${tokenInput}
            onInput=${(e: any) => setTokenInput(e.target.value)}
          />
          <button class="painel-btn painel-btn-accent" onClick=${onSaveToken}>Salvar</button>
        </div>
      </header>

      <nav class="painel-tabs">
        <button
          class=${'painel-tab-btn' + (activeTab === 'saude' ? ' active' : '')}
          onClick=${() => selectTab('saude')}
        >
          Saúde
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'conta' ? ' active' : '')}
          onClick=${() => selectTab('conta')}
        >
          Conta Debrid
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'gate' ? ' active' : '')}
          onClick=${() => selectTab('gate')}
        >
          Gate
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'colhedor' ? ' active' : '')}
          onClick=${() => selectTab('colhedor')}
        >
          Colhedor
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'sonda' ? ' active' : '')}
          onClick=${() => selectTab('sonda')}
        >
          Sonda BR
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'chupim' ? ' active' : '')}
          onClick=${() => selectTab('chupim')}
        >
          Chupim
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'cache' ? ' active' : '')}
          onClick=${() => selectTab('cache')}
        >
          Cache
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'limpeza' ? ' active' : '')}
          onClick=${() => selectTab('limpeza')}
        >
          Limpeza
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'magnets' ? ' active' : '')}
          onClick=${() => selectTab('magnets')}
        >
          Magnets
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'diagnostico' ? ' active' : '')}
          onClick=${() => selectTab('diagnostico')}
        >
          Diagnóstico
        </button>
      </nav>

      <main class="painel-content">
        ${!appState.token ? html`
          <div class="painel-empty">
            <h2>Nenhum token configurado</h2>
            <p>Insira o token de diagnóstico no cabeçalho para carregar o status em tempo real.</p>
          </div>
        ` : appState.error ? html`
          <div class="painel-empty" style="border-color: var(--red);">
            <h2 style="color: var(--red);">Falha ao carregar dados</h2>
            <p>${appState.error}</p>
          </div>
        ` : html`
          ${activeTab === 'saude' ? html`
            <${ViewSaude}
              general=${p.general}
              debrid=${p.debrid}
              conta=${p.conta}
              searchFirst=${p.searchFirst}
            />
          ` : activeTab === 'conta' ? html`
            <${ViewConta} conta=${p.conta} debrid=${p.debrid} />
          ` : activeTab === 'gate' ? html`
            <${ViewGate} gate=${p.gate} onNavigateField=${navigateToField} />
          ` : activeTab === 'colhedor' ? html`
            <${ViewColhedor} harvest=${p.harvest} metrics=${p.metrics} />
          ` : activeTab === 'sonda' ? html`
            <${ViewSonda} harvest=${p.harvest} f3=${p.f3} metrics=${p.metrics} />
          ` : activeTab === 'chupim' ? html`
            <${ViewChupim} autofetch=${p.autofetch} metrics=${p.metrics} />
          ` : activeTab === 'cache' ? html`
            <${ViewCache} cache=${p.cache} metrics=${p.metrics} />
          ` : activeTab === 'limpeza' ? html`
            <${ViewLimpeza} catalog=${p.catalog} conta=${p.conta} />
          ` : activeTab === 'magnets' ? html`
            <${ViewMagnets} magnetdb=${p.magnetdb} />
          ` : activeTab === 'diagnostico' ? html`
            <${ViewDiagnostico} debrid=${p.debrid} />
          ` : null}
        `}
      </main>

      <${ToastStack} />
      <${ConfirmHost} />
    </div>
  `;
}

