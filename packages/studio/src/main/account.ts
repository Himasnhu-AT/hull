// Signing in to the Hull account (backend/): OAuth 2.0 authorization code with PKCE and a loopback redirect (RFC 8252),
// the way desktop apps sign in through the browser. Hull listens once on 127.0.0.1, opens the account server's page in the
// browser, the person signs in and allows Hull there, the browser comes back to the loopback address with a code, and Hull
// trades the code (and the verifier only it knows) for an app token. The password never passes through Hull.
// Nothing here imports electron.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

const b64url = (b: Buffer): string => b.toString('base64url');

export interface SignIn {
  /** Resolves with the token and the account's email once the browser comes back; rejects on cancel, refusal or timeout. */
  done: Promise<{ token: string; email: string }>;
  /** The page opened in the browser (for a "copy the link" fallback). */
  url: string;
  cancel(): void;
}

export interface SignInOptions {
  /** The account server, like http://127.0.0.1:8787. */
  server: string;
  /** Opens a URL in the person's browser. */
  open(url: string): Promise<void>;
  /** The app's name on the consent page. */
  clientId?: string;
  timeoutMs?: number;
  /** Stand-in for fetch (tests). */
  fetch?: typeof fetch;
}

const page = (title: string, body: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f2ee;color:#1c1b18;font:15px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
main{background:#fff;border-radius:16px;padding:28px 32px;box-shadow:0 0 0 .5px rgba(28,26,22,.15),0 8px 28px rgba(28,26,22,.08);max-width:420px}
h1{margin:0 0 6px;font-size:20px;letter-spacing:-.015em}p{margin:0;color:#57544d}</style><main><h1>${title}</h1><p>${body}</p></main>`;

export async function startSignIn(o: SignInOptions): Promise<SignIn> {
  const doFetch = o.fetch ?? fetch;
  const server = o.server.replace(/\/+$/, '');
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const clientId = o.clientId ?? 'hull';

  let settle!: { ok: (v: { token: string; email: string }) => void; fail: (e: Error) => void };
  const done = new Promise<{ token: string; email: string }>((ok, fail) => { settle = { ok, fail }; });
  done.catch(() => {});
  let finished = false;
  let srv: Server | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (e: Error | null, v?: { token: string; email: string }): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    // Closing right away can cut off the page the browser is still loading; a moment later is enough.
    setTimeout(() => srv?.close(), 500).unref();
    if (e) settle.fail(e); else settle.ok(v!);
  };

  srv = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const reply = (code: number, title: string, body: string): void => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(title, body)); };
    if (u.searchParams.get('state') !== state) { reply(400, 'That sign-in link is not this one', 'Go back to Hull and press Sign in again.'); return; }
    const err = u.searchParams.get('error');
    if (err) { reply(200, 'Sign-in cancelled', 'You can close this tab and go back to Hull.'); finish(new Error(err === 'access_denied' ? 'Sign-in was cancelled in the browser.' : `The account server said: ${err}`)); return; }
    const code = u.searchParams.get('code');
    if (!code) { reply(400, 'Something went wrong', 'The account server sent no code. Try again from Hull.'); return; }
    void (async () => {
      try {
        const r = await doFetch(`${server}/oauth/token`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
        });
        const j = (await r.json().catch(() => ({}))) as { access_token?: string; account?: { email?: string }; error_description?: string; error?: string };
        if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `the account server answered ${r.status}`);
        reply(200, 'Signed in to Hull', 'You can close this tab and go back to Hull.');
        finish(null, { token: j.access_token, email: j.account?.email ?? '' });
      } catch (e) {
        reply(500, 'Sign-in did not finish', 'Go back to Hull and try again.');
        finish(new Error(`Sign-in did not finish: ${e instanceof Error ? e.message : String(e)}`));
      }
    })();
  });
  await new Promise<void>((ok, fail) => { srv!.once('error', fail); srv!.listen(0, '127.0.0.1', () => ok()); });
  const port = (srv.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url = `${server}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' })}`;
  timer = setTimeout(() => finish(new Error('Sign-in timed out. Press Sign in to try again.')), o.timeoutMs ?? 5 * 60_000);
  timer.unref();
  try { await o.open(url); } catch (e) { finish(new Error(`Could not open the browser: ${e instanceof Error ? e.message : String(e)}`)); }
  return { done, url, cancel: () => finish(new Error('Sign-in was cancelled.')) };
}
