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
