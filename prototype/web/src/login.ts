// PROTOTYPE. Signing in to a forge from the worker: OAuth token requests.
//
// - GitHub device flow: no redirect and no client secret, but github.com's
//   /login/* endpoints send no CORS headers, so from a page it only works
//   through the egress extension (smartFetch falls back to it).
// - Forgejo authorization code + PKCE: a public client, no secret. The redirect
//   half runs in the page (main.ts); the code exchange runs here. Forgejo's
//   token endpoint answers CORS when its admin enables [cors].
// - Refresh, for either, when the token came with a refresh_token.

import type { FetchFn } from "./githttp";

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function post(fetchFn: FetchFn, url: string, form: Record<string, string>): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  } catch (e: any) {
    throw new Error(`${new URL(url).host} refused the request from this page (${e?.message ?? e}): no CORS on ${new URL(url).pathname}. Install the egress extension, or (Forgejo) enable [cors] for this origin.`);
  }
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = Object.fromEntries(new URLSearchParams(text));
  }
  if (!res.ok && !json?.error) throw new Error(`${url}: ${res.status} ${text.slice(0, 200)}`);
  return json;
}

export async function tokenRequest(fetchFn: FetchFn, tokenUrl: string, form: Record<string, string>): Promise<TokenResponse> {
  const r = await post(fetchFn, tokenUrl, form);
  if (r.error || !r.access_token) throw new Error(`token request refused: ${r.error ?? "no access_token"}${r.error_description ? ` (${r.error_description})` : ""}`);
  return { ...r, expires_in: r.expires_in ? Number(r.expires_in) : undefined };
}

export function refreshToken(fetchFn: FetchFn, tokenUrl: string, clientId: string, refresh: string) {
  return tokenRequest(fetchFn, tokenUrl, { grant_type: "refresh_token", client_id: clientId, refresh_token: refresh });
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** `host` is the web origin (https://github.com, or a GitHub Enterprise host). */
export async function deviceStart(fetchFn: FetchFn, host: string, clientId: string, scope: string): Promise<DeviceCode> {
  const r = await post(fetchFn, `${host}/login/device/code`, { client_id: clientId, scope });
  if (r.error || !r.device_code) throw new Error(`device flow refused: ${r.error ?? "no device_code"}${r.error_description ? ` (${r.error_description})` : ""}`);
  return { ...r, expires_in: Number(r.expires_in), interval: Number(r.interval ?? 5) };
}

/** One poll. `pending` while the user hasn't approved yet; `slowDown` asks for a longer interval. */
export async function devicePoll(
  fetchFn: FetchFn,
  host: string,
  clientId: string,
  deviceCode: string,
): Promise<{ token: TokenResponse } | { pending: true; slowDown?: number }> {
  const r = await post(fetchFn, `${host}/login/oauth/access_token`, { client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  if (r.access_token) return { token: { ...r, expires_in: r.expires_in ? Number(r.expires_in) : undefined } };
  if (r.error === "authorization_pending") return { pending: true };
  if (r.error === "slow_down") return { pending: true, slowDown: Number(r.interval ?? 10) };
  throw new Error(`sign-in failed: ${r.error ?? "unknown"}${r.error_description ? ` (${r.error_description})` : ""}`);
}
