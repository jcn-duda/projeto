// Helper de asserção de render do painel (compartilhado pelos testes de views).
/** Texto visível de um VNode já expandido (a função do componente foi chamada
 * direto). Percorre children e também title/badge/label dos componentes do kit —
 * é assim que uma asserção de conteúdo deixa de ser "typeof object". */
export function vnodeText(node: any): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(vnodeText).join(' ');
  if (typeof node === 'object') {
    const props = node.props || {};
    return [
      typeof props.title === 'string' ? props.title : '',
      typeof props.badge?.text === 'string' ? props.badge.text : '',
      typeof props.label === 'string' ? props.label : '',
      vnodeText(props.children),
    ].join(' ');
  }
  return '';
}
