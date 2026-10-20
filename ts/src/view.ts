// Dohvatanje tokena pregleda sa klaka-api (core/spec/token.md §5).

export interface Options {
  /** Osnovni URL klaka-api, npr. `https://klaka.example.org`. */
  api: string;
  portal: string;
  post: string;
  /** Posle ovoliko ms se odustaje; podrazumevano 5000. */
  timeoutMs?: number;
  /** Osnovni URL klaka-collector-a; bez njega se događaji ne šalju. */
  collector?: string;
}

export interface View {
  token: string;
  vid: string;
}

/** Samo token (za portale koji ne šalju događaje). */
export async function requestToken(o: Options, f: typeof fetch = fetch): Promise<string | null> {
  return (await requestView(o, f))?.token ?? null;
}

/**
 * `POST /v1/view` sa telom kao `text/plain`: to je „jednostavan" CORS zahtev, bez preflight-a.
 * Svaki neuspeh (mreža, status, tajmaut, neočekivan odgovor) daje `null` — stranica radi dalje,
 * a akcija bez tokena kod SDK-a ide u shadow.
 */
export async function requestView(o: Options, f: typeof fetch = fetch): Promise<View | null> {
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
    const body = (await res.json()) as { token?: unknown; vid?: unknown } | null;
    return typeof body?.token === "string" && typeof body.vid === "string" ? { token: body.token, vid: body.vid } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
