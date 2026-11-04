import { z } from "zod";
import { companyParam, selectCompany } from "../company-select.js";
import {
  callPcapi, callPcapiJson, getBankTransactionListPage, getBankTransactionMatching, type BankMatchState, type WebLogin,
} from "../web.js";

// ============================================================
// Helpers
// ============================================================

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dateField = (desc: string) => z.string().regex(datePattern, "Format: YYYY-MM-DD").describe(desc);

const MAX_RANGE_DAYS = 366;
const DEFAULT_ROW_LIMIT = 200;
const MAX_ROW_LIMIT = 1000;

type Direction = "incoming" | "outgoing";
type Row = Record<string, unknown>;

export interface BankTransaction {
  id: string | null;
  rawId: string;
  bankAccount: string;
  valueDate: string;
  type: string;
  partner: string;
  partnerAccount: string;
  amount: number;
  direction: Direction;
  reference: string;
}

/** Parses a strict calendar date (YYYY-MM-DD) into a UTC timestamp, or throws. */
function parseDay(value: string, name: string): number {
  if (!datePattern.test(value)) throw new Error(`${name}: format is YYYY-MM-DD.`);
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) {
    throw new Error(`${name}: no such date (${value}).`);
  }
  return t;
}

function checkRange(from: string, to: string): void {
  const a = parseDay(from, "dateFrom");
  const b = parseDay(to, "dateTo");
  if (b < a) throw new Error("dateTo cannot be earlier than dateFrom.");
  if ((b - a) / 86_400_000 + 1 > MAX_RANGE_DAYS) {
    throw new Error(`One request can cover at most ${MAX_RANGE_DAYS} days.`);
  }
}

/** RFC 4180-style parser for `;`-separated, double-quoted CSV (doubled quotes, newlines in quotes). */
export function parseCsv(text: string, sep = ";"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** Column titles of the Számlázz.hu bank export, exactly as the server sends them. */
const COLUMNS = {
  bankAccount: "Bankszámlaszám",
  valueDate: "Értéknap",
  type: "Tranzakció típusa",
  partner: "Partner neve",
  partnerAccount: "Ellenoldali számlaszám",
  amount: "Tranzakció összege",
  direction: "Kimenő/Bejövő",
  reference: "Közlemény",
  id: "Tranzakció azonosító",
} as const;

/** Values of the direction column: the server writes "Bejövő" (incoming) or "Kimenő" (outgoing). */
const INCOMING_PREFIX = "bej";
const OUTGOING_PREFIX = "kim";

const norm = (s: string) => s.normalize("NFC").trim().toLowerCase();

/** Turns the Számlázz.hu bank export CSV into transactions. */
export function parseBankCsv(text: string): BankTransaction[] {
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 15).toLowerCase();
  if (head.startsWith("{") || head.startsWith("[")) {
    throw new Error("Számlázz.hu sent JSON instead of CSV; its internal interface has probably changed.");
  }
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map(norm);
  const col: Record<keyof typeof COLUMNS, number> = {} as Record<keyof typeof COLUMNS, number>;
  for (const [key, title] of Object.entries(COLUMNS) as Array<[keyof typeof COLUMNS, string]>) {
    col[key] = header.indexOf(norm(title));
  }
  const missing = (Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>).filter((k) => col[k] < 0 && k !== "partnerAccount" && k !== "type");
  if (missing.length) {
    throw new Error(`Column(s) missing from the Számlázz.hu bank export: ${missing.map((k) => COLUMNS[k]).join(", ")}. The format may have changed.`);
  }
  const get = (r: string[], k: keyof typeof COLUMNS) => (col[k] >= 0 ? (r[col[k]] ?? "").trim() : "");
  return rows.slice(1).map((r) => {
    const raw = get(r, "id");
    const idMatch = raw.match(/#\s*(\d+)\s*\)?\s*$/);
    const amount = Number(get(r, "amount").replace(/\s/g, "").replace(",", "."));
    const dirRaw = norm(get(r, "direction"));
    const direction: Direction = dirRaw.startsWith(INCOMING_PREFIX) ? "incoming"
      : dirRaw.startsWith(OUTGOING_PREFIX) ? "outgoing"
      : amount < 0 ? "outgoing" : "incoming";
    return {
      id: idMatch ? idMatch[1] : null,
      rawId: raw,
      bankAccount: get(r, "bankAccount"),
      valueDate: get(r, "valueDate").slice(0, 10),
      type: get(r, "type"),
      partner: get(r, "partner"),
      partnerAccount: get(r, "partnerAccount"),
      amount: Number.isFinite(amount) ? amount : NaN,
      direction,
      reference: get(r, "reference").replace(/\s+/g, " "),
    };
  });
}

async function fetchTransactions(query: string | undefined, from: string, to: string, bankAccountId?: number) {
  checkRange(from, to);
  const { login, company } = await selectCompany(query);
  const body: Record<string, unknown> = { fromDate: from, toDate: to };
  if (bankAccountId && bankAccountId > 0) body.bankszlaId = bankAccountId;
  const csv = await callPcapi(login, "banktranz/list/byinterval", body, "text/csv");
  return { login, companyName: company.name, transactions: parseBankCsv(csv) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ============================================================
// Matching state (from the bank transaction list page)
// ============================================================

const MATCH_STATES: BankMatchState[] = ["unmatched", "partlySettled", "fullySettled", "excluded"];
/** The list page renders at most this many rows per request. */
const PAGE_ROW_CAP = 200;

const ENTITIES: Record<string, string> = {
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", ouml: "ö", odblac: "ő", uacute: "ú", uuml: "ü", udblac: "ű",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Ouml: "Ö", Odblac: "Ő", Uacute: "Ú", Uuml: "Ü", Udblac: "Ű",
  amp: "&", quot: '"', lt: "<", gt: ">", nbsp: " ", apos: "'",
};

export function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name] ?? m);
}

/** "-1 817 196" or "1 768 782 HUF" -> number. */
function amountOf(s: string): number | null {
  const cleaned = decodeHtml(s).replace(/[^\d,.-]/g, "").replace(",", ".");
  if (!cleaned || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

interface ListPageRow { id: string; remaining: number | null }

/** Rows of the list page: transaction id and, for matched ones, the unmatched remainder. */
export function parseBankListPage(html: string): { rows: ListPageRow[]; found: number | null } {
  const rows: ListPageRow[] = [];
  for (const m of html.matchAll(/<tr class="invoice transaction[^"]*" data-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const title = m[2].match(/data-bind="consumeKind"[^>]*?title="([^"]*)"/)?.[1] ?? "";
    const rest = decodeHtml(title).match(/fennmaradó összeg:\s*(-?[\d\s .,]+)/);
    rows.push({ id: m[1], remaining: rest ? amountOf(rest[1]) : null });
  }
  const found = html.match(/Találatok száma:\s*([\d\s ]+)/);
  return { rows, found: found ? amountOf(found[1]) : null };
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * id -> matching state for a period. One request per state; a period with more than the page's
 * row cap is split in half until every part fits.
 */
async function matchStates(login: WebLogin, from: string, to: string, bankAccountId?: number) {
  const states = new Map<string, { state: BankMatchState; remaining: number | null }>();
  let incomplete = false;
  const collect = async (state: BankMatchState, a: string, b: string): Promise<void> => {
    const { rows, found } = parseBankListPage(await getBankTransactionListPage(login, { state, dateFrom: a, dateTo: b, bankAccountId }));
    if (found !== null && rows.length < found && rows.length >= PAGE_ROW_CAP) {
      if (a < b) {
        const days = Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
        const mid = addDays(a, Math.floor(days / 2));
        await collect(state, a, mid);
        await collect(state, addDays(mid, 1), b);
        return;
      }
      incomplete = true; // more than the cap on a single day
    }
    for (const r of rows) states.set(r.id, { state, remaining: r.remaining });
  };
  await Promise.all(MATCH_STATES.map((st) => collect(st, from, to)));
  return { states, incomplete };
}

// ============================================================
// list_bank_transactions
// ============================================================

export const listBankTransactionsSchema = z.object({
  company: companyParam,
  dateFrom: dateField("First value date (YYYY-MM-DD)"),
  dateTo: dateField("Last value date (YYYY-MM-DD), at most 366 days after dateFrom"),
  direction: z.enum(["incoming", "outgoing"]).optional().describe("Only incoming or only outgoing transactions"),
  matchStatus: z.enum(["toDo", "unmatched", "partlySettled", "fullySettled", "excluded"]).optional()
    .describe("Only transactions in this matching state: toDo (unmatched or partly settled, the bank page's " +
      "'only what needs action'), unmatched, partlySettled, fullySettled, or excluded"),
  search: z.string().optional().describe("Text filter on reference, partner name and id, case-insensitive"),
  bankAccountId: z.number().int().positive().optional().describe("Számlázz.hu internal bank account id (optional; default: all)"),
  limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional().describe(`Max rows returned (default ${DEFAULT_ROW_LIMIT})`),
});

export async function listBankTransactions(params: z.infer<typeof listBankTransactionsSchema>): Promise<string> {
  const { login, companyName, transactions } = await fetchTransactions(params.company, params.dateFrom, params.dateTo, params.bankAccountId);

  let matching: Awaited<ReturnType<typeof matchStates>> | null = null;
  let matchingNote: string | undefined;
  try {
    matching = await matchStates(login, params.dateFrom, params.dateTo, params.bankAccountId);
  } catch (e) {
    if (params.matchStatus) throw e;
    matchingNote = `Matching state unavailable: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (matching?.incomplete) {
    matchingNote = "Some days have more transactions than the matching page shows; those have matchStatus \"unknown\".";
  }

  const rows = transactions.map((t) => {
    if (!matching) return t;
    const m = t.id ? matching.states.get(t.id) : undefined;
    const unmatchedAmount = !m ? null
      : m.state === "unmatched" ? Math.abs(t.amount)
      : m.state === "fullySettled" || m.state === "excluded" ? 0
      : m.remaining !== null ? Math.abs(m.remaining) : null;
    return { ...t, matchStatus: m?.state ?? "unknown", unmatchedAmount };
  });

  const needle = params.search ? norm(params.search) : "";
  const wanted: string[] | null = params.matchStatus === "toDo" ? ["unmatched", "partlySettled"]
    : params.matchStatus ? [params.matchStatus] : null;
  const filtered = rows.filter((t) =>
    (!params.direction || t.direction === params.direction) &&
    (!needle || norm(`${t.reference} ${t.partner} ${t.rawId}`).includes(needle)) &&
    (!wanted || wanted.includes(String((t as Row).matchStatus)))
  );
  const limit = params.limit ?? DEFAULT_ROW_LIMIT;
  const sum = (dir: Direction) =>
    round2(filtered.filter((t) => t.direction === dir && Number.isFinite(t.amount)).reduce((a, t) => a + Math.abs(t.amount), 0));
  const countByMatchStatus = matching
    ? Object.fromEntries([...MATCH_STATES, "unknown"]
      .map((st) => [st, filtered.filter((t) => (t as Row).matchStatus === st).length] as const)
      .filter(([, n]) => n > 0))
    : undefined;

  return JSON.stringify({
    success: true,
    company: companyName,
    period: { from: params.dateFrom, to: params.dateTo },
    count: filtered.length,
    incomingTotal: sum("incoming"),
    outgoingTotal: sum("outgoing"),
    countByMatchStatus,
    transactions: filtered.slice(0, limit),
    ...(filtered.length > limit ? { note: `Only the first ${limit} of ${filtered.length} transactions are shown; narrow it (direction, matchStatus, search, period) or raise the limit.` } : {}),
    ...(matchingNote ? { matchingNote } : {}),
    source: "Számlázz.hu web interface (undocumented internal endpoints): transactions from the bank export, matching state from the bank transaction list.",
  });
}

// ============================================================
// get_bank_transaction
// ============================================================

export const getBankTransactionSchema = z.object({
  company: companyParam,
  transactionId: z.number().int().positive().describe("Transaction id, as list_bank_transactions returns it in id"),
});

const textOf = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const amountField = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? amountOf(v) : null);

export async function getBankTransaction(params: z.infer<typeof getBankTransactionSchema>): Promise<string> {
  const { login, company } = await selectCompany(params.company);
  const core = (await callPcapiJson<{ bankTranz?: Row }>(login, "banktranz/get/byid", { id: params.transactionId }, { bankTranz: "all" })).bankTranz;
  if (!core) throw new Error(`No bank transaction ${params.transactionId}.`);
  const amount = typeof core.osszegSigned === "number" ? core.osszegSigned : 0;
  const m = await getBankTransactionMatching(login, params.transactionId, amount < 0);

  const invoices = Array.isArray(m.jovair) ? (m.jovair as Row[]) : [];
  const suggestions = [
    ...(Array.isArray(m.szfejParositasKimeno) ? (m.szfejParositasKimeno as Row[]) : []),
    ...(Array.isArray(m.szfejBejovo) ? (m.szfejBejovo as Row[]) : []),
  ];
  return JSON.stringify({
    success: true,
    company: company.name,
    transaction: {
      id: params.transactionId,
      valueDate: textOf(core.erteknap),
      amount,
      currency: textOf(core.devizaJel),
      direction: amount < 0 ? "outgoing" : "incoming",
      partner: textOf(core.epartner),
      partnerAccount: textOf(core.eszamla),
      ownAccount: textOf(m.bszlaSzamStr),
      bank: textOf(m.bszlaBankTipus),
      type: textOf(core.tranzakcioTipusMegnevezes),
      reference: textOf(core.kozlemeny),
    },
    matching: {
      status: textOf(m.btranzRecordStatusDesc),
      detail: textOf(m.btranzRecordStatus),
      info: textOf(m.btranzStatusInfo),
      settled: textOf(m.consumeKind),
      matchedAmount: amountField(m.btranzOsszegUsedStr),
      unmatchedAmount: amountField(m.btranzOsszegUnusedStr),
      needsAction: m.todo === true,
    },
    matchedInvoices: invoices.map((j) => ({
      invoiceNumber: textOf(j.szfejSzlasz),
      direction: j.jovair_kimeno === true ? "outgoing" : "incoming",
      amount: amountField(j.jovairOsszegStr),
      invoiceGross: amountField(j.szfejBrutOsszStr),
      matchedBy: textOf(j.jovairPairedStr),
      comment: textOf(j.jovairDesc),
      recordedBy: textOf(j.usrName),
      recordedAt: textOf(j.jovairRogzDatStr),
    })),
    // Invoices Számlázz.hu itself offers for matching; often empty.
    suggestedInvoices: suggestions.map((sg) =>
      Object.fromEntries(Object.entries(sg).filter(([, v]) => v !== null && v !== "" && typeof v !== "object"))),
  });
}
