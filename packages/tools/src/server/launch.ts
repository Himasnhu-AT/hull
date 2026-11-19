// The page options a game opens with (?start=camp&look=night). The Studio's Game view keeps them per project, and the
// server stores them so a second window or an agent sees the same ones. They are plain key=value pairs: anything that
// could break out of a query (a fragment, spaces, control characters, bad escapes) is dropped, never passed on.

/** Cleans a launch query: no leading ?, no fragment, pairs re-encoded, a bare flag stays a bare flag. */
export function cleanLaunchQuery(raw: string): string {
  const text = raw.trim().replace(/^\?/, '').split('#')[0]!;
  const out = new URLSearchParams();
  for (const part of text.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    let key: string, value: string;
    try {
      key = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' ')).trim();
      value = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')).trim();
    } catch { continue; }
    if (!key || /[\x00-\x1f]/.test(key + value)) continue;
    out.append(key, value);
  }
  return out.toString().replace(/=(&|$)/g, '$1');
}

/** The page URL with a launch query applied (an existing query on the URL is kept first). */
export function withLaunch(url: string, query: string): string {
  if (!query) return url;
  return url + (url.includes('?') ? '&' : '?') + query;
}
