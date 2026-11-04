/**
 * Számlázz.hu web session client, for data the Agent API does not offer (bank transactions).
 *
 * Signs in like the browser does (POST /szamla/ with the user's web login), then calls the
 * web app's own backend (/szamla/pcapi/...) with the session cookie and the shadow-login token,
 * exactly as the Számlázz.hu pages do. Only the endpoints listed in ALLOWED_PCAPI can be called:
 * the same session could also issue, settle or delete documents, so nothing else is reachable
 * from this module.
 *
 * The password is sent only to https://www.szamlazz.hu and is never logged or returned.
 */

const ORIGIN = "https://www.szamlazz.hu";
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = "Mozilla/5.0 (compatible; szamlazz-mcp)";

/**
 * Read-only web endpoints this MCP may call. Anything else is refused before a request is made:
 * the same session could also issue, settle, storno or delete documents.
 */
const ALLOWED_PCAPI: ReadonlySet<string> = new Set([
  "banktranz/list/byinterval", // bank transactions (CSV)
  "szfej/list",                // invoice list / search by number
  "szfej/get/byid",            // invoice header (JSON) or its PDF
  "sztet/list/byszfejid",      // invoice line items
  "nyfej/list/all",            // receipt list / search by number
  "nyfej/get/byid",            // receipt data
  "nyfej/getpdf/byid",         // receipt PDF
]);

export interface WebLogin {
  username: string;
  password: string;
  /** Számlázz.hu company id (when one login has several companies); default: the login's current company. */
  companyId?: number;
}

/** A company the web login can work in. */
export interface WebCompany {
  companyId: number;
  name: string | null;
}

interface Session {
  cookies: Map<string, string>;
  token: string;
  companyId: number;
  companies: WebCompany[];
  validUntil?: number;
}

/** One session per login, in memory only; it dies with the process. */
const sessions = new Map<string, Session>();

export class WebLoginError extends Error {}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeCookies(jar: Map<string, string>, response: Response): void {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function send(url: string, init: RequestInit, jar: Map<string, string>): Promise<Response> {
  const target = new URL(url, ORIGIN);
  if (target.origin !== ORIGIN) {
    throw new WebLoginError("Számlázz.hu redirected outside www.szamlazz.hu; stopped.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Cookie: cookieHeader(jar), ...((init.headers as Record<string, string>) || {}) },
    });
    storeCookies(jar, response);
    return response;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new WebLoginError(`Számlázz.hu did not answer within ${REQUEST_TIMEOUT_MS / 1000} s.`);
    }
    throw new WebLoginError(`Számlázz.hu is unreachable: ${err instanceof Error ? err.message : "unknown error"}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Follows same-origin redirects by hand so every hop's cookies are kept. */
async function sendFollowing(url: string, init: RequestInit, jar: Map<string, string>): Promise<Response> {
  let response = await send(url, init, jar);
  let current = new URL(url, ORIGIN);
  for (let hop = 0; hop < 5 && response.status >= 300 && response.status < 400; hop++) {
    const location = response.headers.get("location");
    if (!location) break;
    await response.arrayBuffer();
    current = new URL(location, current);
    response = await send(current.href, { method: "GET" }, jar);
  }
  return response;
}

async function signIn(login: WebLogin): Promise<Session> {
  const jar = new Map<string, string>();
  // The login page sets the initial session cookie, as in a browser.
  await (await sendFollowing("/szamla/login", { method: "GET" }, jar)).arrayBuffer();
  const form = new URLSearchParams({ action: "login", usrloginname: login.username, usrpassword: login.password });
  await (await sendFollowing("/szamla/", {
    method: "POST",
    body: form.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }, jar)).arrayBuffer();

  // A successful login is proven by the web app's own shadow login, which hands out its API token.
  const response = await send("/szamla/pcapi/shadowlogin", {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  }, jar);
  const text = await response.text();
  let data: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    data = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    data = null;
  }
  const token = data && typeof data.token === "string" && data.token ? data.token : null;
  const current = data && typeof data.currentCeg === "object" && data.currentCeg ? data.currentCeg as Record<string, unknown> : null;
  if (!response.ok || !data || !token || !current) {
    throw new WebLoginError(
      "Számlázz.hu sign-in failed: wrong username or password, two-factor authentication is on, " +
      "or Számlázz.hu changed its sign-in. Check the username and password in ~/.szamlazz-mcp/config.json."
    );
  }
  const cegList = Array.isArray(data.cegList) ? data.cegList as Array<Record<string, unknown>> : [];
  let companyId = Number(current.id);
  if (login.companyId !== undefined) {
    if (companyId !== login.companyId && !cegList.some((c) => Number(c?.id) === login.companyId)) {
      throw new WebLoginError(`This login has no company with id ${login.companyId}.`);
    }
    companyId = login.companyId;
  }
  if (!Number.isFinite(companyId)) {
    throw new WebLoginError("The Számlázz.hu sign-in returned no company id.");
  }
  const validUntil = typeof data.tokenValidUntil === "number" ? data.tokenValidUntil : undefined;
  const nameOf = (c: Record<string, unknown>) =>
    typeof c.name === "string" ? c.name : typeof c.companyName === "string" ? c.companyName : null;
  const companies = (cegList.length ? cegList : [current])
    .filter((c) => c && Number.isFinite(Number(c.id)))
    .map((c) => ({ companyId: Number(c.id), name: nameOf(c) }));
  return { cookies: jar, token, companyId, companies, validUntil };
}

/** The companies this web login can work in, and the one the tools use. Signs in if needed. */
export async function listWebCompanies(login: WebLogin): Promise<{ currentCompanyId: number; companies: WebCompany[] }> {
  const s = await getSession(login, false);
  return { currentCompanyId: s.companyId, companies: s.companies };
}

async function getSession(login: WebLogin, fresh: boolean): Promise<Session> {
  const key = `${login.username.toLowerCase()}#${login.companyId ?? ""}`;
  const cached = sessions.get(key);
  if (!fresh && cached && (!cached.validUntil || cached.validUntil - 60_000 > Date.now())) return cached;
  sessions.delete(key);
  const created = await signIn(login);
  sessions.set(key, created);
  return created;
}

export interface PcapiOptions {
  accept?: string;
  /** The web app's "Projection" header: which fields of which entities to return. */
  projection?: unknown;
}

/** A "not found" answer of the web backend (e.g. no such invoice). */
export class WebNotFoundError extends WebLoginError {}

function serverMessage(text: string): string | null {
  try {
    const data = JSON.parse(text) as { errors?: Array<{ message?: unknown }> };
    const msg = data.errors?.[0]?.message;
    return typeof msg === "string" ? msg.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/**
 * Calls one allow-listed web endpoint as the signed-in user and returns the raw body. A rejected
 * or expired session is renewed once with a fresh sign-in.
 */
export async function callPcapiRaw(login: WebLogin, endpoint: string, body: unknown, options: PcapiOptions = {}): Promise<Buffer> {
  if (!ALLOWED_PCAPI.has(endpoint)) {
    throw new WebLoginError(`Web endpoint "${endpoint}" is not allowed in this MCP.`);
  }
  for (const fresh of [false, true]) {
    const s = await getSession(login, fresh);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: options.accept ?? "application/json",
      "shadow-login-token": s.token,
      "shadow-login-ceg-id": String(s.companyId),
    };
    if (options.projection !== undefined) headers.Projection = JSON.stringify(options.projection);
    const response = await send(`/szamla/pcapi/${endpoint}`, { method: "POST", body: JSON.stringify(body), headers }, s.cookies);
    const buf = Buffer.from(await response.arrayBuffer());
    const head = buf.subarray(0, 64).toString("utf8").replace(/^﻿/, "").trimStart().slice(0, 15).toLowerCase();
    const isHtml = head.startsWith("<!doctype") || head.startsWith("<html");
    if (response.ok && !isHtml) return buf;
    const expired = response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400) || isHtml;
    if (!fresh && expired) continue; // session expired: sign in again, once
    const msg = serverMessage(buf.toString("utf8"));
    if (response.status === 404) throw new WebNotFoundError(msg || "No such document.");
    throw new WebLoginError(`Számlázz.hu rejected the web request (HTTP ${response.status})${msg ? ": " + msg : "."}`);
  }
  throw new WebLoginError("Could not renew the Számlázz.hu web session.");
}

/** Like callPcapiRaw, as text. */
export async function callPcapi(login: WebLogin, endpoint: string, body: unknown, options: PcapiOptions | string = {}): Promise<string> {
  const opts = typeof options === "string" ? { accept: options } : options;
  return (await callPcapiRaw(login, endpoint, body, opts)).toString("utf8");
}

/** Like callPcapi, parsed as JSON. */
export async function callPcapiJson<T = Record<string, unknown>>(login: WebLogin, endpoint: string, body: unknown, projection?: unknown): Promise<T> {
  const text = await callPcapi(login, endpoint, body, { projection });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new WebLoginError("Számlázz.hu sent an unreadable answer; its internal interface may have changed.");
  }
}

/** For tests: forget cached sessions. */
export function resetWebSessions(): void {
  sessions.clear();
}
