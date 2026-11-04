import { z } from "zod";
import { companyParam, selectCompany } from "../company-select.js";
import { callPcapi } from "../web.js";

// ============================================================
// Helpers
// ============================================================

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dateField = (desc: string) => z.string().regex(datePattern, "Format: YYYY-MM-DD").describe(desc);

const MAX_RANGE_DAYS = 366;
const DEFAULT_ROW_LIMIT = 200;
const MAX_ROW_LIMIT = 1000;

type Direction = "incoming" | "outgoing";

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
  return { companyName: company.name, transactions: parseBankCsv(csv) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ============================================================
// list_bank_transactions
// ============================================================

export const listBankTransactionsSchema = z.object({
  company: companyParam,
  dateFrom: dateField("First value date (YYYY-MM-DD)"),
  dateTo: dateField("Last value date (YYYY-MM-DD), at most 366 days after dateFrom"),
  direction: z.enum(["incoming", "outgoing"]).optional().describe("Only incoming or only outgoing transactions"),
  search: z.string().optional().describe("Text filter on reference, partner name and id, case-insensitive"),
  bankAccountId: z.number().int().positive().optional().describe("Számlázz.hu internal bank account id (optional; default: all)"),
  limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional().describe(`Max rows returned (default ${DEFAULT_ROW_LIMIT})`),
});

export async function listBankTransactions(params: z.infer<typeof listBankTransactionsSchema>): Promise<string> {
  const { companyName, transactions } = await fetchTransactions(params.company, params.dateFrom, params.dateTo, params.bankAccountId);
  const needle = params.search ? norm(params.search) : "";
  const filtered = transactions.filter((t) =>
    (!params.direction || t.direction === params.direction) &&
    (!needle || norm(`${t.reference} ${t.partner} ${t.rawId}`).includes(needle))
  );
  const limit = params.limit ?? DEFAULT_ROW_LIMIT;
  const sum = (dir: Direction) =>
    round2(filtered.filter((t) => t.direction === dir && Number.isFinite(t.amount)).reduce((a, t) => a + Math.abs(t.amount), 0));
  return JSON.stringify({
    success: true,
    company: companyName,
    period: { from: params.dateFrom, to: params.dateTo },
    count: filtered.length,
    incomingTotal: sum("incoming"),
    outgoingTotal: sum("outgoing"),
    transactions: filtered.slice(0, limit),
    ...(filtered.length > limit ? { note: `Only the first ${limit} of ${filtered.length} transactions are shown; narrow it (direction, search, period) or raise the limit.` } : {}),
    source: "Számlázz.hu web interface (undocumented internal endpoint); no matching status included.",
  });
}
