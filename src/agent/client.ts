/**
 * Client for the Számlázz.hu Agent API (https://docs.szamlazz.hu/): one multipart POST per call,
 * the XML document in a file field named after the action. Answers come as XML, a bare PDF or,
 * for errors, in szlahu_error* response headers.
 */
import { XMLParser } from "fast-xml-parser";
import type { AgentRequest } from "./requests.js";

const AGENT_URL = "https://www.szamlazz.hu/szamla/";
const TIMEOUT_MS = 30_000;

type Tree = Record<string, unknown>;

export interface AgentAnswer {
  ok: boolean;
  /** szlahu_* response headers, URL-decoded. */
  headers: Record<string, string>;
  /** The parsed XML answer, if the answer was XML. */
  document?: Tree;
  /** The PDF: the answer itself, or the one embedded in the XML answer. */
  pdf?: Buffer;
  documentNumber?: string;
  net?: string;
  gross?: string;
  buyerAccountUrl?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  // Keep values as sent: postcodes, tax numbers and document numbers are text, not numbers.
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  // Accented letters arrive as numeric character references.
  htmlEntities: true,
  ignoreDeclaration: true,
});

function decodeHeaderValue(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/** Depth-first search for the first value stored under `key` anywhere in a parsed XML tree. */
export function findValue(tree: unknown, key: string): unknown {
  if (!tree || typeof tree !== "object") return undefined;
  const node = tree as Tree;
  if (key in node) return node[key];
  for (const child of Object.values(node)) {
    const hit = findValue(child, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The document element of a parsed answer: its name and content. */
function rootElement(tree: Tree): { name: string; body: Tree } | null {
  for (const [name, body] of Object.entries(tree)) {
    if (!name.startsWith("?") && body && typeof body === "object") return { name, body: body as Tree };
  }
  return null;
}

const SECRET_OR_BULKY = new Set(["pdf", "nyugtaPdf", "felhasznalo", "jelszo", "szamlaagentkulcs", "kulcstartojelszo"]);

/** A copy of a parsed answer without embedded PDFs or anything that could be a credential. */
export function withoutSecrets(tree: Tree): Tree {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Tree).filter(([k]) => !SECRET_OR_BULKY.has(k)).map(([k, v]) => [k, walk(v)])
    );
  };
  return walk(tree) as Tree;
}

/** An error's message for a tool answer, with anything shaped like an API key masked. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "[redacted]");
}

async function post(req: AgentRequest): Promise<Response> {
  const form = new FormData();
  form.append(req.action, new Blob([req.xml], { type: "application/xml" }), `${req.action}.xml`);
  try {
    // The request carries the password: never follow a redirect anywhere.
    return await fetch(AGENT_URL, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`Számlázz.hu Agent API did not answer within ${TIMEOUT_MS / 1000} s.`);
    }
    throw new Error(`Számlázz.hu Agent API is unreachable: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}

export async function callAgent(req: AgentRequest): Promise<AgentAnswer> {
  const response = await post(req);

  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith("szlahu_")) headers[name.toLowerCase()] = decodeHeaderValue(value);
  });
  if (headers.szlahu_error || headers.szlahu_error_code) {
    throw new Error(`Számlázz.hu error ${headers.szlahu_error_code ?? "?"}: ${headers.szlahu_error ?? "no message"}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { ok: true, headers, pdf: body, ...numbersFrom(headers) };
  }

  // The Content-Type is not reliable (XML comes as application/octet-stream), so look at the body.
  const text = body.toString("utf8").replace(/^﻿/, "").trimStart();
  if (text.startsWith("[ERR]")) {
    // Text answers put the message first and a server stack trace after a dashed line.
    throw new Error(`Számlázz.hu error: ${text.slice(5).split("----------")[0].trim().slice(0, 500)}`);
  }
  if (!text) return { ok: false, headers, ...numbersFrom(headers) };
  if (!text.startsWith("<")) {
    throw new Error(`Számlázz.hu Agent API sent an unexpected answer (HTTP ${response.status}).`);
  }

  // Some actions answer "xmlagentresponse=DONE;..." as plain text that starts like markup.
  if (text.includes("xmlagentresponse=")) {
    return { ok: text.includes("DONE"), headers, ...numbersFrom(headers) };
  }

  let document: Tree;
  try {
    document = parser.parse(text) as Tree;
  } catch {
    throw new Error("Számlázz.hu Agent API sent unreadable XML.");
  }

  // Status answers are named "...valasz" (xmlszamlavalasz, xmlnyugtavalasz, ...) and carry <sikeres>.
  const root = rootElement(document);
  const isStatusAnswer = !!root && root.name.endsWith("valasz");
  if (isStatusAnswer && String(root!.body.sikeres) !== "true") {
    const code = root!.body.hibakod ?? "?";
    const message = String(root!.body.hibauzenet ?? "no message").trim().slice(0, 500);
    throw new Error(`Számlázz.hu error ${code}: ${message}`);
  }

  const embedded = findValue(document, "pdf") ?? findValue(document, "nyugtaPdf");
  return {
    ok: true,
    headers,
    document,
    pdf: typeof embedded === "string" && embedded ? Buffer.from(embedded, "base64") : undefined,
    ...numbersFrom(headers, document),
  };
}

/** Document number and totals: from the szlahu_* headers, else from the XML answer. */
function numbersFrom(headers: Record<string, string>, document?: Tree) {
  const fromXml = (key: string) => {
    const v = document ? findValue(document, key) : undefined;
    return v === undefined || v === null || v === "" ? undefined : String(v);
  };
  return {
    documentNumber: headers.szlahu_szamlaszam || fromXml("szamlaszam"),
    net: headers.szlahu_nettovegosszeg || fromXml("szamlanetto"),
    gross: headers.szlahu_bruttovegosszeg || fromXml("szamlabrutto"),
    buyerAccountUrl: headers.szlahu_vevoifiokurl || undefined,
  };
}
