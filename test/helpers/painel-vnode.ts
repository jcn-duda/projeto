/* Utilidades de VNode para os testes do cliente do /painel.
 *
 * Os componentes do painel são funções puras de preact (sem DOM): o teste as
 * CHAMA direto e precisa olhar a árvore resultante. Estas duas funções eram
 * cópias em quase toda suíte do painel — uma versão só evita a divergência de
 * "o teste X acha o botão, o teste Y não" quando um componente aninhado
 * (Card, Button, Badge) muda de forma.
 *
 * `expand` resolve componentes de função (inclusive aninhados) e devolve só os
 * VNodes de elemento; `textOf` achata o texto visível incluindo `title`,
 * `badge.text` e `label` — o texto que o operador realmente lê. */

export function expand(node: any): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (n == null || n === false || n === true) return;
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    if (typeof n !== 'object') return;
    if (typeof n.type === 'function') {
      walk(n.type(n.props || {}));
      return;
    }
    out.push(n);
    walk(n.props?.children);
  };
  walk(node);
  return out;
}

export function textOf(node: any): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node !== 'object') return '';
  if (typeof node.type === 'function') return textOf(node.type(node.props || {}));
  const props = node.props || {};
  return [
    typeof props.title === 'string' ? props.title : '',
    typeof props.badge?.text === 'string' ? props.badge.text : '',
    typeof props.label === 'string' ? props.label : '',
    textOf(props.children),
  ].join(' ');
}
