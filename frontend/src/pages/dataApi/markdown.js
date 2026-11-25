/* Markdown-lite to HTML for the key email editor. */

// Quotes too: a link's URL lands inside href="...".
const escHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TOKEN_LABEL = { '{{key}}': 'API key', '{{base_url}}': 'Base URL' };

function mdInline(text) {
  return escHtml(text)
    .replace(/\{\{(key|base_url)\}\}/g, (m) => `<span class="rtok" contenteditable="false" data-token="${m}">${TOKEN_LABEL[m]}</span>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

export function mdToHtml(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${mdInline(i)}</li>`).join('')}</${list.tag}>`); list = null; };
  lines.forEach((raw) => {
    const line = raw.trim();
    const h = line.match(/^#{1,3}\s+(.*)$/);
    const b = line.match(/^[-*]\s+(.*)$/);
    const n = line.match(/^\d+[.)]\s+(.*)$/);
    if (!line) { flushPara(); flushList(); return; }
    if (h) { flushPara(); flushList(); out.push(`<h3>${mdInline(h[1])}</h3>`); return; }
    if (b || n) {
      flushPara();
      const tag = b ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((b || n)[1]);
      return;
    }
    flushList();
    para.push(raw.replace(/^\s{4,}/, '    '));
  });
  flushPara(); flushList();
  return out.join('');
}
