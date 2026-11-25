/* Shared, non-component helpers for the Communication Center and the
 * directory pickers that reuse it. */

export const CLS = {
  card:      'bg-white border border-jj-gray-02 rounded-2xl',
  label:     'block font-johnson-text text-[12.5px] text-jj-gray-06 mb-1.5',
  hint:      'font-johnson-text text-[11.5px] text-jj-gray-05',
  input:     'w-full px-3 py-2.5 rounded-[10px] border border-jj-gray-03 bg-white font-johnson-text ' +
             'text-[13px] text-jj-gray-08 outline-none focus:border-jj-red focus:ring-[3px] focus:ring-jj-red/10',
  inputSm:   'w-full px-2.5 py-1.5 rounded-lg border border-jj-gray-02 bg-white font-johnson-text ' +
             'text-[12.5px] text-jj-gray-08 outline-none focus:border-jj-red',
  sectionH:  'font-johnson-display font-medium text-[15px] leading-tight text-jj-gray-08',
  railH:     'font-johnson-text text-[10.5px] uppercase tracking-[0.09em] text-jj-gray-05 font-medium',
  ghostBtn:  'px-3.5 py-2.5 rounded-[10px] border border-jj-gray-03 bg-white font-johnson-text ' +
             'text-[13px] text-jj-gray-08 hover:bg-jj-gray-01 disabled:opacity-50',
  primaryBtn:'px-4 py-2.5 rounded-[10px] bg-jj-red text-white font-johnson-text text-[13px] ' +
             'font-medium hover:bg-jj-maroon-05 transition-colors disabled:opacity-60',
  chipBtn:   'px-1.5 py-1 rounded-md border border-jj-gray-02 font-johnson-text text-[11px] ' +
             'text-jj-gray-07 hover:border-jj-gray-04 disabled:opacity-40',
};

/* Example text for each message type — the compose fields' placeholders and
   the welcome screen's sample banners, so the two never disagree. */
export const PLACEHOLDERS = {
  update:      { bannerTitle: 'Release Notes',          bannerSubtitle: 'GRA Data Quality Engine',        headline: "What's new this month",        subject: 'New in SmartHub: ' },
  warning:     { bannerTitle: 'Action required',        bannerSubtitle: 'SmartHub Alert!',                headline: 'Please review before Friday',  subject: 'Your SmartHub access needs re-approval' },
  maintenance: { bannerTitle: 'Scheduled maintenance',  bannerSubtitle: 'Day 01 Month, Time - Time PM ET', headline: 'SmartHub will be unavailable', subject: 'Planned downtime this Saturday' },
  custom:      { bannerTitle: 'SmartHub information session', bannerSubtitle: 'Updates to SmartHub',      headline: 'Thanks for joining us',        subject: "Recap from today's session" },
};

/* Several of the J&J SVGs ship with a baked-in white fill, which is invisible
   on a white button. Colour comes from a filter rather than currentColor,
   since the fill is in the file and not inheritable. */
export const ICON_TONES = {
  white: 'brightness(0) invert(1)',
  dark:  'brightness(0) saturate(100%) invert(15%) sepia(7%) saturate(806%) hue-rotate(346deg) brightness(95%) contrast(89%)',
  gray:  'brightness(0) saturate(100%) invert(50%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)',
  red:   'brightness(0) saturate(100%) invert(13%) sepia(97%) saturate(6477%) hue-rotate(359deg) brightness(91%) contrast(99%)',
  green: 'brightness(0) saturate(100%) invert(37%) sepia(87%) saturate(1158%) hue-rotate(71deg) brightness(91%) contrast(93%)',
};

export const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Same splitting rule the backend uses: comma, semicolon or newline. */
export const splitAddresses = (raw) =>
  String(raw || '')
    .split(/[,;\n\r]+/)
    .map((s) => s.trim().replace(/^<|>$/g, ''))
    .filter(Boolean);

export const ADDR_RE = /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/;

/* AD display names carry a trailing affiliation tag — "Bakash, Alla [JRDUS
 * NON-J&J]". Same trim the group member list does. */
export const cleanName = (raw) => String(raw || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();


export async function graphToken(instance, accounts) {
  if (!accounts.length) throw new Error('Sign in to search the directory');
  const auth = await instance.acquireTokenSilent({
    scopes: ['User.Read.All'],
    account: accounts[0],
  });
  if (!auth?.accessToken) throw new Error('Could not get a directory token');
  return auth.accessToken;
}

/**
 * One directory lookup, used by the picker, the suggestion dropdown and the
 * Data Studio share box.
 *
 * $search (with ConsistencyLevel: eventual) matches the start of any word, so
 * a given name finds "Surname, Given" and a surname finds it too. A tenant or
 * token that refuses $search gets the older startswith filter, which only
 * matches the front of the display name, mailbox or UPN.
 *
 * No $orderby: Graph refuses it next to $filter on /users unless the request
 * opts into advanced queries. Sorted here instead, best match first.
 */
const DIRECTORY_FIELDS = 'id,displayName,mail,userPrincipalName,jobTitle';

export async function searchDirectory(token, query, limit) {
  const words = query.replace(/["\\]/g, ' ').trim();
  const search = ['displayName', 'mail', 'userPrincipalName'].map((f) => `"${f}:${words}"`).join(' OR ');
  let res = await fetch(
    `${GRAPH}/users?$search=${encodeURIComponent(search)}&$top=${limit}&$select=${DIRECTORY_FIELDS}`,
    { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } },
  );
  if (res.status === 400 || res.status === 403) {
    // Doubling the quote is how a literal one is escaped inside an OData
    // string - an apostrophe in a surname would otherwise end the filter.
    const safe = encodeURIComponent(query.replace(/'/g, "''"));
    const filter =
      `startswith(displayName,'${safe}') or startswith(mail,'${safe}') ` +
      `or startswith(userPrincipalName,'${safe}')`;
    res = await fetch(
      `${GRAPH}/users?$filter=${filter}&$top=${limit}&$select=${DIRECTORY_FIELDS}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  }
  if (!res.ok) {
    // Graph puts the actual complaint in the body. Showing only the status
    // sent us looking in the wrong place once already.
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message
      || `Directory search returned ${res.status}`);
  }

  const data = await res.json();
  const q = words.toLowerCase();
  // Name or address starting with what was typed first, then any word starting with it.
  const rank = (u) => ((u.name.toLowerCase().startsWith(q) || u.email.toLowerCase().startsWith(q)) ? 0 : 1);
  return (data.value || [])
    .map((u) => ({
      id: u.id,
      name: cleanName(u.displayName),
      email: u.mail || u.userPrincipalName || '',
      title: u.jobTitle || '',
    }))
    .filter((u) => u.email)
    .sort((a, b) => rank(a) - rank(b) || (a.name || a.email).localeCompare(b.name || b.email));
}

/* ─── Compose body: markdown-lite ⇄ the formatted editor ─────────────────────
 *
 * The compose body is stored as the markdown-lite that body_to_html() in
 * backend/communication_center.py renders, so templates, drafts, AI output and
 * the send path never see anything else. These two functions carry it in and
 * out of the rich editor: markupToHtml follows the backend's rules line for
 * line, and htmlToMarkup writes back only what the backend understands. */

/* eslint-disable no-control-regex -- control characters are stripped here on
   purpose, the same way the backend strips them before rendering */
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */
const LINK_RE = /\[([^\]\n]{1,200})\]\(\s*((?:https?:\/\/|mailto:)[^\s)"']+)\s*\)/g;
const BOLD_ITALIC_RE = /\*\*\*(.+?)\*\*\*/gs;
const BOLD_RE = /\*\*(.+?)\*\*/gs;
const ITALIC_RE = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs;
// Bare addresses: the backend links them in the email, so the editor shows
// them the same way. A styled <span>, not a link, so editing them stays plain
// text and the markup never changes.
const URL_RE = /(https?:\/\/[^\s<>"]+)/g;
const HEADING_RE = /^(#{1,3})\s+(\S.*)$/;
const BULLET_RE = /^[-*]\s+(\S.*)$/;
const NUMBER_RE = /^\d{1,3}[.)]\s+(\S.*)$/;
// Placeholders for links held out of the bold/italic pass. Control characters,
// so they cannot clash with typed text: CONTROL_RE has already removed those.
// eslint-disable-next-line no-control-regex
const HOLD_RE = /\u0001(\d+)\u0001/g;

/** A list line as the backend reads one: "- ", "* ", "1. " or "1) " and text. */
export const LIST_LINE_RE = /^\s*(?:[-*]|\d{1,3}[.)])\s+\S/;

export const SAFE_HREF_RE = /^(?:https?:\/\/|mailto:)[^\s)"'<>]+$/i;

// Zero-width space: invisible in the email, but it stops the backend reading a
// typed "- " as a bullet or two touching runs of marks as one broken marker.
const ZWSP = '\u200b';
// A literal asterisk typed in rich mode is sent as the asterisk operator, which
// looks the same and can never pair up into bold or italic.
const LITERAL_STAR = '\u2217';

/** Text and attribute safe. Quotes are left alone inside text, where the
 *  backend leaves them too, by escaping them only on request. */
export const escapeHtml = (text, { quotes = true } = {}) => {
  const out = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return quotes ? out.replace(/"/g, '&quot;') : out;
};

const renderInline = (escaped) => {
  const held = [];
  const out = escaped
    .replace(LINK_RE, (_, text, href) => {
      held.push(`<a href="${href}">${text}</a>`);
      return `\u0001${held.length - 1}\u0001`;
    })
    .replace(BOLD_ITALIC_RE, '<strong><em>$1</em></strong>')
    .replace(BOLD_RE, '<strong>$1</strong>')
    .replace(ITALIC_RE, '<em>$1</em>')
    .replace(URL_RE, '<span class="cc-rte-url">$1</span>');
  return out.replace(HOLD_RE, (match, index) => held[Number(index)] ?? match);
};

export const LIST_DEPTH = 3;

const indentWidth = (line) => {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
};

/** Nested lists from [level, tag, text] rows, the way the backend builds them:
 *  a sub-list opens inside the item above it, and a change of type at one
 *  level closes that list and opens the other. */
const renderList = (items) => {
  let out = '';
  const open = [];
  const close = () => { out += `</li></${open.pop()}>`; };
  for (const [level, tag, text] of items) {
    while (open.length > level + 1) close();
    if (open.length === level + 1 && open[open.length - 1] !== tag) close();
    if (open.length === level + 1) out += '</li>';
    while (open.length < level + 1) {
      out += `<${tag}>`;
      open.push(tag);
    }
    out += `<li>${renderInline(text)}`;
  }
  while (open.length) close();
  return out;
};

/** Markdown-lite → the editor's HTML. Blocks close whenever the kind of line
 *  changes, exactly as the backend does it. */
export const markupToHtml = (markup) => {
  const text = (markup || '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
  const blocks = [];
  let paragraph = [];
  let items = [];
  let indents = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!items.length) return;
    blocks.push(renderList(items));
    items = [];
    indents = [];
  };

  for (const line of escapeHtml(text, { quotes: false }).split('\n')) {
    const stripped = line.trim();
    if (!stripped) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING_RE.exec(stripped);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = BULLET_RE.exec(stripped);
    const number = bullet ? null : NUMBER_RE.exec(stripped);
    if (bullet || number) {
      flushParagraph();
      const width = indentWidth(line);
      if (!indents.length) indents.push(width);
      else if (width > indents[indents.length - 1]) {
        if (indents.length < LIST_DEPTH) indents.push(width);
      } else {
        while (indents.length > 1 && width < indents[indents.length - 1]) indents.pop();
      }
      items.push([indents.length - 1, bullet ? 'ul' : 'ol', (bullet || number)[1]]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks.join('');
};

/* ─── HTML → markdown-lite ──────────────────────────────────────────────── */

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'META', 'LINK', 'TITLE', 'HEAD']);
const ELEMENT = 1;
const TEXT = 3;

const BLOCK_QUERY = [...BLOCK_TAGS].join(',').toLowerCase();
const isBlock = (node) => node.nodeType === ELEMENT && BLOCK_TAGS.has(node.tagName);

/** Bold and italic as the node sets them, including the inline styles Word and
 *  Google Docs paste in (Docs wraps whole documents in <b style="font-weight:normal">). */
const marksOf = (el, marks) => {
  let { bold, italic } = marks;
  const tag = el.tagName;
  if (tag === 'B' || tag === 'STRONG') bold = true;
  if (tag === 'I' || tag === 'EM') italic = true;
  const weight = el.style?.fontWeight;
  if (weight) bold = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
  const style = el.style?.fontStyle;
  if (style) italic = style === 'italic' || style === 'oblique';
  return { bold, italic };
};

const collectRuns = (node, marks, runs) => {
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT) {
      if (child.data) runs.push({ text: child.data, ...marks });
      continue;
    }
    if (child.nodeType !== ELEMENT || SKIP_TAGS.has(child.tagName)) continue;
    if (child.tagName === 'BR') {
      runs.push({ br: true });
      continue;
    }
    if (child.tagName === 'A') {
      const href = (child.getAttribute('href') || '').trim();
      const text = child.textContent.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim().slice(0, 200);
      if (text && SAFE_HREF_RE.test(href)) runs.push({ link: text, href });
      else if (text) runs.push({ text, ...marksOf(child, marks) });
      continue;
    }
    if (isBlock(child)) runs.push({ br: true });
    collectRuns(child, marksOf(child, marks), runs);
    if (isBlock(child)) runs.push({ br: true });
  }
  return runs;
};

const plain = (text) => text.replace(/\u00a0/g, ' ').replace(/\*/g, LITERAL_STAR);

/** One block's inline content. Line breaks survive as \n. */
const NO_MARKS = { bold: false, italic: false };

const inlineMarkup = (node, marks = NO_MARKS) => {
  const runs = collectRuns(node, marks, []);
  let out = '';
  let lastMarked = false;
  let pending = null;

  const emit = (run) => {
    if (run.br) {
      out += '\n';
      lastMarked = false;
      return;
    }
    if (run.link) {
      out += `[${run.link}](${run.href})`;
      lastMarked = false;
      return;
    }
    const text = plain(run.text);
    const marker = run.bold && run.italic ? '***' : run.bold ? '**' : run.italic ? '*' : '';
    if (!marker || !text.trim()) {
      out += text;
      lastMarked = false;
      return;
    }
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    if (lastMarked && !lead) out += ZWSP;
    out += `${lead}${marker}${core}${marker}${trail}`;
    lastMarked = !trail;
  };

  // Neighbouring text with the same marks is one run, so "bo" + "ld" never
  // comes out as **bo****ld**.
  for (const run of runs) {
    if (pending && !run.br && !run.link && !pending.br && !pending.link
        && pending.bold === run.bold && pending.italic === run.italic) {
      pending = { ...pending, text: pending.text + run.text };
      continue;
    }
    if (pending) emit(pending);
    pending = run;
  }
  if (pending) emit(pending);
  return out;
};

const BLOCK_START_RE = /^(\s*)(?=[-*\u2217]\s|#{1,3}\s|\d{1,3}[.)]\s)/;

const paragraphMarkup = (text) => text
  .split('\n')
  .map((line) => line.replace(/\s+$/, ''))
  .join('\n')
  .replace(/^\n+|\n+$/g, '')
  .replace(/\n{2,}/g, '\n\n')
  .split('\n')
  .map((line) => line.replace(BLOCK_START_RE, `$1${ZWSP}`))
  .join('\n');

const singleLine = (text) => text.replace(/\s*\n\s*/g, ' ').trim();

const LIST_TAGS = new Set(['UL', 'OL']);

/** Items of one list and its sub-lists with how deep each sits. Also reads the
 *  <ul> Chrome's indent command drops straight inside another <ul>. */
const listItems = (list, items, marks, depth = 0) => {
  const ordered = list.tagName === 'OL';
  let n = 0;
  for (const child of list.children) {
    if (LIST_TAGS.has(child.tagName)) {
      listItems(child, items, marksOf(child, marks), depth + 1);
      continue;
    }
    const clone = child.cloneNode(true);
    clone.querySelectorAll('ul,ol').forEach((el) => el.remove());
    const text = singleLine(inlineMarkup(clone, marksOf(child, marks)));
    if (text) {
      n += 1;
      items.push({ depth, ordered, n, text });
    }
    for (const sub of child.querySelectorAll(':scope > ul, :scope > ol')) {
      listItems(sub, items, marksOf(child, marks), depth + 1);
    }
  }
};

/** Two spaces of indent per level. A level can only open under an item, so the
 *  first item is level 0 and none sits more than one below the one above it;
 *  that is how the backend reads the indents, so the email nests the same. */
const listMarkup = (items) => {
  let previous = -1;
  return items.map(({ depth, ordered, n, text }) => {
    const level = Math.min(depth, previous + 1, LIST_DEPTH - 1);
    previous = level;
    return `${'  '.repeat(level)}${ordered ? `${n}.` : '-'} ${text}`;
  }).join('\n');
};

const collectBlocks = (root, blocks, marks = NO_MARKS) => {
  let loose = [];
  const flushLoose = () => {
    if (!loose.length) return;
    const holder = root.ownerDocument.createElement('div');
    loose.forEach((node) => holder.append(node.cloneNode(true)));
    const text = paragraphMarkup(inlineMarkup(holder, marks));
    if (text.trim()) blocks.push(text);
    loose = [];
  };

  for (const child of root.childNodes) {
    if (child.nodeType === ELEMENT && SKIP_TAGS.has(child.tagName)) continue;
    if (!isBlock(child)) {
      // An inline wrapper round whole paragraphs (Docs pastes one <b> round the
      // document) is a container, not a run of text.
      if (child.nodeType === ELEMENT && child.querySelector(BLOCK_QUERY)) {
        flushLoose();
        collectBlocks(child, blocks, marksOf(child, marks));
      } else if (child.nodeType === TEXT || child.nodeType === ELEMENT) {
        loose.push(child);
      }
      continue;
    }
    flushLoose();
    const tag = child.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const text = singleLine(inlineMarkup(child, marksOf(child, marks)));
      if (text) blocks.push(`${'#'.repeat(Math.min(Number(tag[1]), 3))} ${text}`);
    } else if (tag === 'UL' || tag === 'OL' || tag === 'LI') {
      const items = [];
      if (tag === 'LI') {
        const holder = root.ownerDocument.createElement('ul');
        holder.append(child.cloneNode(true));
        listItems(holder, items, marks);
      } else {
        listItems(child, items, marksOf(child, marks));
      }
      if (items.length) blocks.push(listMarkup(items));
    } else if (tag === 'HR') {
      continue;
    } else if ([...child.childNodes].some(isBlock)) {
      collectBlocks(child, blocks, marksOf(child, marks));
    } else {
      const text = paragraphMarkup(inlineMarkup(child, marksOf(child, marks)));
      if (text.trim()) blocks.push(text);
    }
  }
  flushLoose();
  return blocks;
};

/** The editor's HTML (or anything pasted into it) → markdown-lite. */
export const htmlToMarkup = (root) => collectBlocks(root, []).join('\n\n');

/** Pasted HTML, parsed off-document so nothing in it runs or loads. */
export const pastedHtmlToMarkup = (html) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return htmlToMarkup(doc.body);
};

/* ─── Live address styling while typing ─────────────────────────────────── */

const WHOLE_URL_RE = /^https?:\/\/[^\s<>"]+/;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"]+/g;

/** Keeps the styled bare addresses true to what the email will link as the
 *  admin types: text typed onto the end of one is moved out of it, a mangled
 *  one goes back to plain text, and a newly typed one is styled once the caret
 *  has left it. Only ever splits and moves the text nodes the caret is not in,
 *  so typing is never interrupted. */
export const tidyAddresses = (root) => {
  const sel = root.ownerDocument.getSelection();
  const caret = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const caretNode = caret ? caret.startContainer : null;
  const caretOffset = caret ? caret.startOffset : -1;

  for (const span of root.querySelectorAll('.cc-rte-url')) {
    const text = span.textContent;
    const match = WHOLE_URL_RE.exec(text);
    const only = span.childNodes.length === 1 && span.firstChild.nodeType === TEXT;
    if (!match || !only) {
      span.replaceWith(...span.childNodes);
      continue;
    }
    if (match[0].length < text.length) {
      // splitText carries the caret into the new node, so it stays put.
      span.after(span.firstChild.splitText(match[0].length));
    }
  }

  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const pending = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('a,.cc-rte-url')) continue;
    if (URL_IN_TEXT_RE.test(node.data)) pending.push(node);
    URL_IN_TEXT_RE.lastIndex = 0;
  }
  for (const node of pending) {
    const matches = [...node.data.matchAll(URL_IN_TEXT_RE)];
    // Back to front, so earlier offsets stay valid as the node is split.
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const { index } = matches[i];
      const end = index + matches[i][0].length;
      // The caret is in it, so it is still being typed or edited: moving the
      // node would throw the caret out. Styled once the caret leaves.
      if (node === caretNode && caretOffset >= index && caretOffset <= end) continue;
      const url = node.splitText(index);
      url.splitText(end - index);
      const span = root.ownerDocument.createElement('span');
      span.className = 'cc-rte-url';
      url.replaceWith(span);
      span.append(url);
    }
  }
};

/* ─── Scrollbars ──────────────────────────────────────────────────────────────
 *
 * Communication Center scrollbars: a slim warm-gray thumb on a clear track,
 * with a chevron at each end. One definition for two places: the page itself
 * (scoped to its panes, the welcome screen and the app's main scroller while
 * either is mounted) and the sandboxed email preview, a separate document the
 * page's styles cannot reach. */

const PAGE_SCOPE = ':is(#main-content:has(.cc-root, .cw), .cc-root, .cc-root *, .cw, .cw *)';

const REST = '8a7f77';
const HOT = '312c2a';
const ARROWS = {
  'vertical:decrement': 'M2.75 6.1 5 3.9 7.25 6.1',
  'vertical:increment': 'M2.75 3.9 5 6.1 7.25 3.9',
  'horizontal:decrement': 'M6.1 2.75 3.9 5 6.1 7.25',
  'horizontal:increment': 'M3.9 2.75 6.1 5 3.9 7.25',
};

const chevron = (path, color) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E`
  + `%3Cpath d='${path}' fill='none' stroke='%23${color}' stroke-width='1.6' stroke-linecap='round' `
  + `stroke-linejoin='round'/%3E%3C/svg%3E")`;

/** The rules, for every scroller matching `scope` (all of them when empty). */
export const scrollbarCss = (scope = '') => {
  const bar = (pseudo = '') => `${scope}::-webkit-scrollbar${pseudo}`;
  const button = (pseudo = '') => bar(`-button${pseudo}`);
  return [
    `${bar()}{width:10px;height:10px}`,
    `${bar('-track')},${bar('-corner')}{background:transparent}`,
    `${bar('-thumb')}{border:2px solid transparent;border-radius:999px;`
      + 'background:rgba(110,98,89,.26) padding-box;min-height:40px}',
    `${bar('-thumb:hover')}{background:rgba(110,98,89,.48) padding-box}`,
    `${bar('-thumb:active')}{background:rgba(235,23,0,.55) padding-box}`,
    // One chevron at each end, centred in the track; the doubled buttons some
    // platforms add stay hidden.
    `${button()}{display:none}`,
    `${button(':single-button')}{display:block;background-color:transparent;background-repeat:no-repeat;`
      + 'background-position:center;background-size:10px 10px;border-radius:999px}',
    `${button(':single-button:vertical')}{height:14px}`,
    `${button(':single-button:horizontal')}{width:14px}`,
    ...Object.entries(ARROWS).flatMap(([where, path]) => [
      `${button(`:single-button:${where}`)}{background-image:${chevron(path, REST)}}`,
      `${button(`:single-button:${where}:hover`)}{background-image:${chevron(path, HOT)}}`,
    ]),
    `${button(':single-button:active')}{background-color:rgba(110,98,89,.14)}`,
    // Firefox has no ::-webkit-scrollbar; the standard properties get it close.
    `@supports not selector(::-webkit-scrollbar){${scope || 'html'}`
      + '{scrollbar-width:thin;scrollbar-color:rgba(110,98,89,.36) transparent}}',
  ].join('\n');
};

/** The page's own rules: its panes, the welcome screen, and the app's main
 *  scroller while either is mounted. */
export const pageScrollbarCss = () => scrollbarCss(PAGE_SCOPE);

/** The preview copy of an email with the same scrollbars. Goes after the
 *  doctype, never before it: anything ahead of <!DOCTYPE> drops the preview
 *  into quirks mode and it would stop matching the sent email. */
export const withPreviewScrollbars = (html) => {
  const style = `<style data-cc-preview>${scrollbarCss()}</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${style}</head>`);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + style + html.slice(doctype[0].length) : style + html;
};
