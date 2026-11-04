/**
 * More read tools around one invoice (payments, NAV submissions, e-mails, reminders) and the
 * turnover report. Same web backend calls as the invoice detail page and the Forgalom page.
 */
import { z } from "zod";
import { companyParam, selectCompany } from "../company-select.js";
import { callPcapi, callPcapiJson } from "../web.js";
import { parseCsv } from "./bank.js";
import { BY_DIRECTION, directionParam, findInvoice, num, str, type Direction } from "./documents.js";
import { fetchPages } from "./paging.js";

type Row = Record<string, unknown>;

const invoiceNumberParam = z.string().min(1).describe("Invoice number (e.g. 'E-2024-123')");
const fullName = (usr: unknown) => {
  const u = usr as Row | undefined;
  return [str(u?.vezeteknev), str(u?.keresztnev)].filter(Boolean).join(" ") || undefined;
};

// ============================================================
// get_invoice_payments
// ============================================================

export const getInvoicePaymentsSchema = z.object({
  company: companyParam,
  direction: directionParam,
  invoiceNumber: invoiceNumberParam,
});

export async function getInvoicePayments(params: z.infer<typeof getInvoicePaymentsSchema>): Promise<string> {
  const direction: Direction = params.direction ?? "outgoing";
  const { kimeno } = BY_DIRECTION[direction];
  const { login } = await selectCompany(params.company);
  const found = await findInvoice(login, params.invoiceNumber, direction);
  const id = found.id as number;

  const summary = await callPcapiJson<Row>(login, "szfej/jovairsummary/byid", { id, kimeno });
  const entries = await fetchPages(login, "szfejjovair/list/byid", { id, kimeno },
    { items: { szfejJovair: "all", usr: "name" } },
    (item) => item.szfejJovair ? { ...(item.szfejJovair as Row), usr: item.usr } : undefined, 500, 50);

  const gross = num(found.brutOssz);
  const paid = num(found.kifizOssz) ?? num(found.befizOssz);
  return JSON.stringify({
    success: true,
    direction,
    invoiceNumber: str(found.szlasz),
    gross,
    paid,
    outstanding: gross === null ? null : Math.round((gross - (paid ?? 0)) * 100) / 100,
    currency: str(found.deviza),
    lastPayment: summary && num(summary.amount) !== null ? {
      date: str(summary.date),
      amount: num(summary.amount),
      method: str(summary.type),
      bankAccount: str(summary.bankAccount),
    } : null,
    payments: entries.rows.map((p) => ({
      date: str(p.dat),
      method: str(p.jogcim),
      amount: num(p.osszeg),
      comment: str(p.desc),
      recordedAt: str(p.rogzDat),
      recordedBy: fullName(p.usr),
      bankTransactionId: num(p.banktranz_id) && (p.banktranz_id as number) > 0 ? p.banktranz_id : undefined,
    })),
    ...(entries.rows.length === 0 && paid ? { note: "The paid amount is recorded without separate payment entries." } : {}),
  });
}

// ============================================================
// get_invoice_activity
// ============================================================

export const getInvoiceActivitySchema = z.object({
  company: companyParam,
  direction: directionParam,
  invoiceNumber: invoiceNumberParam,
});

/** Drops empty values so raw backend rows stay readable. */
function compact(row: Row | undefined): Row | undefined {
  if (!row) return undefined;
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

export async function getInvoiceActivity(params: z.infer<typeof getInvoiceActivitySchema>): Promise<string> {
  const direction: Direction = params.direction ?? "outgoing";
  const { kimeno } = BY_DIRECTION[direction];
  const { login } = await selectCompany(params.company);
  const found = await findInvoice(login, params.invoiceNumber, direction);
  const szfejId = found.id as number;

  const [systems, emails, reminders] = await Promise.all([
    fetchPages(login, "szfejaccsys/list/byszfejid", { szfejId, kimeno },
      { items: { szfejaccsys: "all", accsys: "name" } },
      (item) => item.szfejAccSys ? { ...(item.szfejAccSys as Row), system: (item.accSys as Row | undefined)?.name } : undefined, 200, 50),
    // E-mails and payment reminders exist only for invoices this company issued; for received ones
    // the backend answers "not found".
    kimeno
      ? fetchPages(login, "szfejsend/list/byszfejid", { szfejId },
        { items: { szfejSend: "all", szfejSendAtts: "none", usr: "name" } },
        (item) => item.szfejSend ? { ...(item.szfejSend as Row), sentBy: fullName(item.usr) } : undefined, 200, 50)
      : Promise.resolve({ rows: [], total: 0, more: false }),
    kimeno
      ? fetchPages(login, "fizker/list/byszfejid", { szfejId, kimeno },
        { items: { fizker: "all", lastFizkerStatusLog: "all" } },
        (item) => item.fizker ? { ...(item.fizker as Row), lastStatus: compact(item.lastFizkerStatusLog as Row) } : undefined, 200)
      : Promise.resolve({ rows: [], total: 0, more: false }),
  ]);

  return JSON.stringify({
    success: true,
    direction,
    invoiceNumber: str(found.szlasz),
    // NAV Online Számla and other connected systems; stateCode is Számlázz.hu's own status number.
    submissions: systems.rows.map((s) => ({
      system: str(s.system),
      stateCode: num(s.szfejAccSysState),
      requestedAt: str(s.szfejAccSysReqDat),
      completedAt: str(s.szfejAccSysSuccDat),
      registrationNumber: str(s.szfejAccSysRegNum),
      transactionKey: str(s.szfejAccSysKey),
    })),
    emails: emails.rows.map(compact),
    paymentReminders: reminders.rows.map(compact),
  });
}

// ============================================================
// turnover_report
// ============================================================

const DOCUMENT_TYPES = {
  invoices: "bizonylat_tipusa_szamla",
  proformas: "bizonylat_tipusa_dijbekero",
  deliveryNotes: "bizonylat_tipusa_szallitolevel",
  all: "bizonylat_tipusa_all",
} as const;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const turnoverReportSchema = z.object({
  company: companyParam,
  dateFrom: z.string().regex(ISO_DAY, "Format: YYYY-MM-DD").describe("First issue date, inclusive (YYYY-MM-DD)"),
  dateTo: z.string().regex(ISO_DAY, "Format: YYYY-MM-DD").describe("Last issue date, inclusive (YYYY-MM-DD)"),
  documentType: z.enum(["invoices", "proformas", "deliveryNotes", "all"]).optional()
    .describe("Which documents this company issued: invoices (default), proformas, deliveryNotes or all"),
  buyer: z.string().optional().describe("Only this buyer (name)"),
  product: z.string().optional().describe("Only items with this product name"),
  limit: z.number().int().min(0).max(5000).optional()
    .describe("Most item rows to return (default 200, 0 = totals only). Totals always cover the whole period"),
});

/** "2022.08.11." -> "2022-08-11" */
const isoDate = (s: string) => {
  const m = s.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s || undefined;
};
const amount = (s: string) => {
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function turnoverReport(params: z.infer<typeof turnoverReportSchema>): Promise<string> {
  if (params.dateTo < params.dateFrom) throw new Error("dateTo cannot be earlier than dateFrom.");
  const { login, company } = await selectCompany(params.company);
  const csv = await callPcapi(login, "szfej/forgalmilista/byinterval", {
    fromDate: params.dateFrom, toDate: params.dateTo,
    partnerName: params.buyer || undefined, cikkName: params.product || undefined,
    groupByType: 0, excelType: "excel_type_csv",
    bizonylatType: DOCUMENT_TYPES[params.documentType ?? "invoices"],
    forrasType: 0, encodingType: "UTF-8",
  }, "text/csv");

  const [header, ...data] = parseCsv(csv);
  if (!header) throw new Error("Számlázz.hu sent an empty turnover report.");
  const col = (title: string) => header.findIndex((h) => h.trim().toLowerCase() === title.toLowerCase());
  const C = {
    number: col("Számlaszám"), type: col("Típus"), buyer: col("Vevő"), buyerTax: col("Vevő adószáma"),
    issued: col("Kelt"), fulfilled: col("Teljesítés"), method: col("Fizetési mód"), item: col("Tétel"),
    itemId: col("Azonosító"), rate: col("Áfakulcs"), qty: col("Mennyiség"), unit: col("Menny.egys."),
    unitPrice: col("Nettó egységár"), net: col("Nettó ár"), vat: col("Áfa"), gross: col("Bruttó ár"),
    currency: col("Devizanem"), fx: col("Árfolyam"), comment: col("Tétel megjegyzés"),
  };
  if (C.number < 0 || C.net < 0) throw new Error("Unexpected turnover report columns; the Számlázz.hu format may have changed.");
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");

  // The report ends with summary lines that have no document number.
  const items = data.filter((r) => at(r, C.number)).map((r) => ({
    documentNumber: at(r, C.number),
    type: at(r, C.type) || undefined,
    buyer: at(r, C.buyer) || undefined,
    buyerTaxNumber: at(r, C.buyerTax) || undefined,
    issueDate: isoDate(at(r, C.issued)),
    fulfillmentDate: isoDate(at(r, C.fulfilled)),
    paymentMethod: at(r, C.method) || undefined,
    item: at(r, C.item) || undefined,
    itemId: at(r, C.itemId) || undefined,
    vatRate: at(r, C.rate) || undefined,
    quantity: amount(at(r, C.qty)),
    unit: at(r, C.unit) || undefined,
    netUnitPrice: amount(at(r, C.unitPrice)),
    net: amount(at(r, C.net)),
    vat: amount(at(r, C.vat)),
    gross: amount(at(r, C.gross)),
    currency: at(r, C.currency) || undefined,
    exchangeRate: amount(at(r, C.fx)) || undefined,
    comment: at(r, C.comment) || undefined,
  }));

  type Sum = { net: number; vat: number; gross: number };
  const add = (map: Map<string, Sum>, key: string, x: { net: number | null; vat: number | null; gross: number | null }) => {
    const s = map.get(key) ?? { net: 0, vat: 0, gross: 0 };
    s.net += x.net ?? 0; s.vat += x.vat ?? 0; s.gross += x.gross ?? 0;
    map.set(key, s);
  };
  const byCurrency = new Map<string, Sum>();
  const byRate = new Map<string, Sum>();
  for (const x of items) {
    add(byCurrency, x.currency ?? "?", x);
    add(byRate, `${x.currency ?? "?"}|${x.vatRate ?? "?"}`, x);
  }
  const rounded = (s: Sum) => ({ net: round2(s.net), vat: round2(s.vat), gross: round2(s.gross) });
  const limit = params.limit ?? 200;

  return JSON.stringify({
    success: true,
    company: company.name,
    scope: "Documents this company issued (the Számlázz.hu Forgalom report); received invoices are not included.",
    period: { from: params.dateFrom, to: params.dateTo },
    documentType: params.documentType ?? "invoices",
    documentCount: new Set(items.map((x) => x.documentNumber)).size,
    itemCount: items.length,
    totalsByCurrency: [...byCurrency].map(([currency, s]) => ({ currency, ...rounded(s) })),
    totalsByVatRate: [...byRate].map(([key, s]) => {
      const [currency, vatRate] = key.split("|");
      return { currency, vatRate, ...rounded(s) };
    }),
    items: items.slice(0, limit),
    ...(items.length > limit ? { note: `Only the first ${limit} of ${items.length} item rows are listed; the totals cover all of them.` } : {}),
  });
}
