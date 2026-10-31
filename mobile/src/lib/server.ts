// The harness server (the laptop's `next dev` on the LAN), baked in at bundle
// time from mobile/.env.local — see .env.example.
const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL?.replace(/\/+$/, "");

export function serverUrl(): string {
  if (!SERVER_URL) throw new Error("EXPO_PUBLIC_SERVER_URL is not set — add it to mobile/.env.local.");
  return SERVER_URL;
}

/** fetch against the harness: relative `/api/...` paths, same signature as
 *  the global so the shared SessionModel can take it as its injected fetch. */
export const apiFetch: typeof fetch = (input, init) => {
  const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return fetch(path.startsWith("/") ? `${serverUrl()}${path}` : path, init);
};

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) throw new Error((await res.text()) || `${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}
