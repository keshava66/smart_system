import { KEY_PLACEHOLDER } from './lib';

/* Light syntax colouring for code snippets and the guide. Each token is
   escaped on its own, so nothing from the code ends up as markup. */
const escCode = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STR = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`;
const NUM = ['n', String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`];
const CODE_TOKENS = {
  python: [
    ['c', String.raw`#[^\n]*`],
    ['s', STR],
    ['k', String.raw`\b(?:import|from|as|def|return|None|True|False|for|in|if|elif|else|while|with|try|except|raise|not|and|or|is|lambda|class|break|continue|pass)\b`],
    ['f', String.raw`\b[A-Za-z_][\w.]*(?=\()`],
    ['a', String.raw`\b[A-Za-z_]\w*(?==[^=])`],
    NUM,
  ],
  pq: [
    ['c', String.raw`//[^\n]*`],
    ['s', STR],
    ['k', String.raw`\b(?:let|in|each|if|then|else)\b`],
    ['f', String.raw`\b[A-Z]\w*\.[A-Za-z]\w*(?=\()`],
    ['a', String.raw`\b[A-Za-z_]\w*(?=\s*=)`],
    NUM,
  ],
  curl: [
    ['c', String.raw`(?:^|(?<=\s))#[^\n]*`],
    ['s', STR],
    ['k', String.raw`^\s*(?:curl|export|set|echo|pip|python3?)\b`],
    ['a', String.raw`(?<=\s)--?[A-Za-z][\w-]*`],
    ['v', String.raw`\$\{?[A-Za-z_]\w*\}?`],
    ['p', String.raw`\\$`],
  ],
  http: [
    ['key', KEY_PLACEHOLDER],
    ['k', String.raw`^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b`],
    ['a', String.raw`^[A-Za-z][\w-]*(?=:\s)`],
    ['s', String.raw`(?<=[?&])[^=&\s]+`],
    ['j', String.raw`[?&=]`],
    ['f', String.raw`(?<=^(?:GET|POST|PUT|PATCH|DELETE)\s+)\S+?(?=[?\s]|$)`],
  ],
  json: [
    ['f', String.raw`"(?:\\.|[^"\\\n])*"(?=\s*:)`],
    ['s', STR],
    ['b', String.raw`\b(?:true|false|null)\b`],
    NUM,
  ],
};
CODE_TOKENS.bash = CODE_TOKENS.curl;
CODE_TOKENS.sh = CODE_TOKENS.curl;
CODE_TOKENS.shell = CODE_TOKENS.curl;
CODE_TOKENS.py = CODE_TOKENS.python;

/* A fence with no language still gets coloured by what it looks like. */
function guessLang(code) {
  const s = code.trimStart();
  if (/^(GET|POST|PUT|PATCH|DELETE)\s/.test(s)) return 'http';
  if (/^curl\b/.test(s)) return 'curl';
  if (/^[[{]/.test(s)) return 'json';
  if (/^(import |from \w+ import |def )/m.test(s)) return 'python';
  if (/^let\b/.test(s)) return 'pq';
  return '';
}

export function highlightCode(code, lang) {
  const key = (lang || '').toLowerCase() || guessLang(code);
  const rules = CODE_TOKENS[key];
  if (!rules) return escCode(code);
  const re = new RegExp(rules.map(([, r]) => `(${r})`).join('|'), 'gm');
  let html = '';
  let last = 0;
  code.replace(re, (m, ...groups) => {
    if (!m) return m;
    const at = groups[rules.length];
    const kind = rules[groups.slice(0, rules.length).findIndex((g) => g !== undefined)][0];
    let piece = escCode(m);
    if (kind === 's' || kind === 'a') piece = piece.split(KEY_PLACEHOLDER).join(`<span class="tk-key">${KEY_PLACEHOLDER}</span>`);
    html += escCode(code.slice(last, at)) + `<span class="tk-${kind}">${piece}</span>`;
    last = at + m.length;
    return m;
  });
  html += escCode(code.slice(last));
  // A placeholder key outside a string (say in an http line) is flagged too.
  return html.replace(new RegExp(`(?<![">])${KEY_PLACEHOLDER}`, 'g'), `<span class="tk-key">${KEY_PLACEHOLDER}</span>`);
}
