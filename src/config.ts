import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * The whole configuration: one Számlázz.hu login. The companies it can work in, their names and
 * ids come from Számlázz.hu after sign-in, so nothing else is stored. Filled in by hand; never
 * set or returned by any tool.
 */
export interface Config {
  username?: string;
  password?: string;
}

const HOME_DIR = join(homedir(), ".szamlazz-mcp");
const CONFIG_PATH = join(HOME_DIR, "config.json");
/** Earlier name of the file; renamed on first load. */
const OLD_CONFIG_PATH = join(HOME_DIR, "companies.json");

/** Writes the config owner-only, through a temp file so a crash never leaves half a file. */
function store(config: Config): void {
  if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, CONFIG_PATH);
}

/**
 * The earlier layout had one entry per company: { companies: { <id>: { webLogin } }, defaultCompany }.
 * Its default company's login (else the first one with a login) becomes the new config.
 */
function fromOldLayout(raw: Record<string, unknown>): Config | null {
  if (!raw.companies || typeof raw.companies !== "object") return null;
  type Entry = { webLogin?: { username?: string; password?: string } };
  const entries = raw.companies as Record<string, Entry>;
  const preferred = typeof raw.defaultCompany === "string" ? entries[raw.defaultCompany] : undefined;
  const pick = preferred?.webLogin?.username ? preferred : Object.values(entries).find((e) => e?.webLogin?.username);
  return { username: pick?.webLogin?.username, password: pick?.webLogin?.password };
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH) && existsSync(OLD_CONFIG_PATH)) renameSync(OLD_CONFIG_PATH, CONFIG_PATH);
  if (!existsSync(CONFIG_PATH)) {
    const blank: Config = { username: "", password: "" };
    store(blank);
    return blank;
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  const migrated = fromOldLayout(raw);
  if (migrated) {
    store(migrated);
    return migrated;
  }
  return {
    username: typeof raw.username === "string" ? raw.username : undefined,
    password: typeof raw.password === "string" ? raw.password : undefined,
  };
}

/** The Számlázz.hu login every tool signs in with. */
export function getLogin(config: Config = loadConfig()): { username: string; password: string } {
  if (!config.username || !config.password) {
    throw new Error(
      `No Számlázz.hu login is set. Write the username and password by hand into ${CONFIG_PATH}: ` +
      `{ "username": "...", "password": "..." }`
    );
  }
  return { username: config.username, password: config.password };
}

// ============================================================
// PDFs in tool answers
// ============================================================

/** Largest PDF sent inside an answer (base64 makes it a third bigger). */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

export interface PdfResult {
  pdfBase64?: string;
  pdfName?: string;
  pdfNote?: string;
}

/** A document number made safe as a file name: no path parts, no characters Windows rejects. */
export function safeFileName(name: string): string {
  const cleaned = name
    .split("")
    .map((ch) => (ch.charCodeAt(0) < 32 || '<>:"|?*'.includes(ch) ? "_" : ch === "/" || ch === "\\" ? "-" : ch))
    .join("")
    .replace(/\.{2,}/g, "_")
    .trim();
  return cleaned || "document";
}

/**
 * A PDF for the tool answer, as base64; index.ts turns it into an embedded application/pdf
 * resource. Nothing is written to disk.
 */
export function handlePdf(name: string, pdf: Buffer): PdfResult {
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") return { pdfNote: "Számlázz.hu did not send a PDF; left out." };
  if (pdf.length > MAX_PDF_BYTES) {
    return { pdfNote: `The PDF is ${(pdf.length / 1048576).toFixed(1)} MB, over the ${MAX_PDF_BYTES / 1048576} MB that fits in an answer.` };
  }
  return { pdfName: safeFileName(name), pdfBase64: pdf.toString("base64") };
}
