// Dohvatanje tokena pregleda sa klaka-api (core/spec/token.md §5).

export interface Options {
  /** Osnovni URL klaka-api, npr. `https://klaka.example.org`. */
  api: string;
  portal: string;
  post: string;
  /** Posle ovoliko ms se odustaje; podrazumevano 5000. */
  timeoutMs?: number;
}

/**
 * `POST /v1/view` sa telom kao `text/plain`: to je „jednostavan" CORS zahtev, bez preflight-a.
 * Svaki neuspeh (mreža, status, tajmaut, neočekivan odgovor) daje `null` — stranica radi dalje,
 * a akcija bez tokena kod SDK-a ide u shadow.
 */
export async function requestToken(o: Options, f: typeof fetch = fetch): Promise<string | null> {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), o.timeoutMs ?? 5000) : undefined;
  try {
    const res = await f(o.api.replace(/\/+$/, "") + "/v1/view", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ portal: o.portal, post: o.post }),
      credentials: "omit",
      signal: ctrl ? ctrl.signal : null,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const token = (body as { token?: unknown } | null)?.token;
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
