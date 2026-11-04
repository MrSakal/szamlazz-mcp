/**
 * Read tools for invoices and receipts over the Számlázz.hu web login (no Agent key needed).
 * Every call goes through the allow-listed, read-only endpoints in ../web.ts. Request and answer
 * field names of those endpoints (szfej, szlasz, kimeno, ...) are Számlázz.hu's own.
 */
import { z } from "zod";
import { companyParam, selectCompany } from "../company-select.js";
import { handlePdf, type PdfResult } from "../config.js";
import { callPcapiJson, callPcapiRaw, WebNotFoundError, type WebLogin } from "../web.js";

type Row = Record<string, unknown>;

/** Projections the Számlázz.hu web app itself sends (which entities and fields come back). */
const INVOICE_LIST_PROJECTION = {
  items: {
    szfej: "szfejkimenolist", szfejParent: "none", szfejVegszamla: "none", szfejHelyesbito: "none",
    szfejStornozo: "none", sztet: "none", payeeCase: "none", partner: "none",
  },
  hasNextPage: "all", totalSize: "all", emptyReason: "none",
};
const INVOICE_DETAIL_PROJECTION = { szfej: "szfejkimenoreszletek" };
const ITEMS_PROJECTION = { items: { sztet: "allkimeno" }, hasNextPage: "all" };
const RECEIPT_LIST_PROJECTION = { items: { nyfej: "list" }, hasNextPage: "all", totalSize: "all" };
const RECEIPT_PROJECTION = { nyfej: "all" };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const round2 = (n: number) => Math.round(n * 100) / 100;
const sameNo = (a: unknown, b: string) => typeof a === "string" && a.trim().toUpperCase() === b.trim().toUpperCase();

/** Open amount of an invoice: gross total minus what was registered as paid. */
function openAmount(header: Row): number | null {
  const gross = num(header.brutOssz);
  const paid = num(header.kifizOssz) ?? 0;
  if (gross === null) return null;
  return round2(gross - paid);
}

function invoiceSummary(h: Row) {
  return {
    invoiceNumber: str(h.szlasz),
    type: str(h.type),
    issueDate: str(h.keltDat),
    fulfillmentDate: str(h.teljDat),
    dueDate: str(h.fizHDat),
    buyer: str(h.partnerName),
    buyerTaxNumber: str(h.partnerTaxNumber),
    net: num(h.nettOssz),
    gross: num(h.brutOssz),
    paid: num(h.kifizOssz),
    outstanding: openAmount(h),
    currency: str(h.deviza),
    paymentMethod: str(h.fizMod),
    reversed: h.storno === true,
  };
}

// ============================================================
// Invoice lookup by number
// ============================================================

async function findInvoice(login: WebLogin, invoiceNumber: string): Promise<Row> {
  const answer = await callPcapiJson<{ items?: Array<{ szfej?: Row }> }>(login, "szfej/list", {
    kimeno: true, page: 0, pageSize: 20,
    orderBy: { orderBy: "ORDERBY_KELTDAT", ascending: false },
    quickSearch: { mode: "SZFEJSZLASZ", value: invoiceNumber.trim() },
  }, INVOICE_LIST_PROJECTION);
  const hit = (answer.items ?? []).map((i) => i.szfej).find((h) => h && sameNo(h.szlasz, invoiceNumber));
  if (!hit || typeof hit.id !== "number") {
    throw new WebNotFoundError(`No outgoing invoice numbered "${invoiceNumber}".`);
  }
  return hit;
}

// ============================================================
// list_invoices
// ============================================================

const SEARCH_MODES = { invoiceNumber: "SZFEJSZLASZ", buyer: "SZFEJPARTNERNAME" } as const;

export const listInvoicesSchema = z.object({
  company: companyParam,
  search: z.string().optional().describe("Text to search for (invoice number or buyer name, per searchBy)"),
  searchBy: z.enum(["invoiceNumber", "buyer"]).optional().describe("What to search (default: invoiceNumber)"),
  page: z.number().int().min(0).optional().describe("Page index from 0 (default: 0)"),
  pageSize: z.number().int().min(1).max(100).optional().describe("Invoices per page (default: 50)"),
  oldestFirst: z.boolean().optional().describe("true: oldest first; default: newest first (by issue date)"),
});

export async function listInvoices(params: z.infer<typeof listInvoicesSchema>): Promise<string> {
  const { login, company } = await selectCompany(params.company);
  const pageSize = params.pageSize ?? 50;
  const body: Row = {
    kimeno: true, page: params.page ?? 0, pageSize,
    orderBy: { orderBy: "ORDERBY_KELTDAT", ascending: params.oldestFirst === true },
  };
  if (params.search && params.search.trim()) {
    body.quickSearch = { mode: SEARCH_MODES[params.searchBy ?? "invoiceNumber"], value: params.search.trim() };
  }
  const answer = await callPcapiJson<{ items?: Array<{ szfej?: Row }>; hasNextPage?: boolean; totalSize?: { count?: number } }>(
    login, "szfej/list", body, INVOICE_LIST_PROJECTION);
  const invoices = (answer.items ?? []).map((i) => i.szfej).filter((h): h is Row => !!h).map(invoiceSummary);
  return JSON.stringify({
    success: true,
    company: company.name,
    total: answer.totalSize?.count ?? null,
    page: params.page ?? 0,
    pageSize,
    hasNextPage: answer.hasNextPage === true,
    invoices,
  });
}

// ============================================================
// get_invoice_data
// ============================================================

export const getInvoiceDataSchema = z.object({
  company: companyParam,
  invoiceNumber: z.string().min(1).describe("Invoice number (e.g. 'E-2024-123')"),
  includePdf: z.boolean().optional().describe("Include the PDF in the answer (default: false)"),
});

export async function getInvoiceData(params: z.infer<typeof getInvoiceDataSchema>): Promise<string> {
  const { login, company } = await selectCompany(params.company);
  const found = await findInvoice(login, params.invoiceNumber);
  const headerId = found.id as number;

  const detail = await callPcapiJson<{ szfej?: Row }>(login, "szfej/get/byid", { id: headerId, kimeno: true }, INVOICE_DETAIL_PROJECTION);
  const h = detail.szfej ?? found;
  const items = await callPcapiJson<{ items?: Array<{ sztet?: Row }> }>(
    login, "sztet/list/byszfejid", { szfejId: headerId, kimeno: true, page: 0, pageSize: 500 }, ITEMS_PROJECTION);

  let pdf: PdfResult = {};
  if (params.includePdf) {
    const buf = await callPcapiRaw(login, "szfej/get/byid", { id: headerId, kimeno: true }, { accept: "application/pdf" });
    pdf = handlePdf(String(h.szlasz ?? params.invoiceNumber), buf);
  }

  return JSON.stringify({
    success: true,
    company: company.name,
    invoice: {
      ...invoiceSummary(h),
      vat: num(h.afaOssz),
      exchangeRate: num(h.devizaArf),
      comment: str(h.desc),
      language: str(h.lang),
      eInvoice: String(h.eSzamla) === "1" || h.eSzamla === true,
      navTransactionId: str(h.navOnlineTrAzon),
      seller: {
        name: str(h.cegCompanyName),
        address: [str(h.cegAddr1), str(h.cegAddr2)].filter(Boolean).join(", ") || undefined,
        taxNumber: str(h.cegTaxNumber),
        bank: str(h.cegBank),
        bankAccount: str(h.cegBankAccount),
      },
      buyerAddress: {
        country: str(h.partnerCountry),
        postalCode: str(h.partnerIrsz),
        city: str(h.partnerCity),
        address: str(h.partnerAddr2),
        email: str(h.email),
      },
      items: (items.items ?? []).map((i) => i.sztet).filter((t): t is Row => !!t).map((t) => ({
        name: str(t.item),
        quantity: num(t.menny),
        unit: str(t.meEgys),
        netUnitPrice: num(t.nettEgysAr),
        net: num(t.nettAr),
        vat: num(t.afa),
        gross: num(t.brutAr),
        comment: str(t.desc),
      })),
    },
    ...pdf,
  });
}

// ============================================================
// get_invoice_pdf
// ============================================================

export const getInvoicePdfSchema = z.object({
  company: companyParam,
  invoiceNumber: z.string().min(1).describe("Invoice number (e.g. 'E-2024-123')"),
});

export async function getInvoicePdf(params: z.infer<typeof getInvoicePdfSchema>): Promise<string> {
  const { login } = await selectCompany(params.company);
  const found = await findInvoice(login, params.invoiceNumber);
  const buf = await callPcapiRaw(login, "szfej/get/byid", { id: found.id, kimeno: true }, { accept: "application/pdf" });
  const invoiceNumber = String(found.szlasz ?? params.invoiceNumber);
  const pdf = handlePdf(invoiceNumber, buf);
  return JSON.stringify({
    success: !!pdf.pdfBase64,
    invoiceNumber,
    net: num(found.nettOssz),
    gross: num(found.brutOssz),
    ...pdf,
    message: pdf.pdfBase64 ? "The PDF is attached to the answer." : pdf.pdfNote || "No PDF came back.",
  });
}

// ============================================================
// get_receipt
// ============================================================

export const getReceiptSchema = z.object({
  company: companyParam,
  receiptNumber: z.string().min(1).describe("Receipt number"),
  includePdf: z.boolean().optional().describe("Include the PDF in the answer (default: false)"),
});

export async function getReceipt(params: z.infer<typeof getReceiptSchema>): Promise<string> {
  const { login, company } = await selectCompany(params.company);
  const list = await callPcapiJson<{ items?: Array<{ nyfej?: Row }>; whyAmIEmpty?: string }>(
    login, "nyfej/list/all", { searchKey: params.receiptNumber.trim(), page: 0, pageSize: 20 }, RECEIPT_LIST_PROJECTION);
  // The receipt number field name is not visible without a receipt; match any text field exactly.
  const hit = (list.items ?? []).map((i) => i.nyfej).find((n) =>
    n && Object.values(n).some((v) => sameNo(v, params.receiptNumber)));
  if (!hit || typeof hit.id !== "number") {
    // "NO_NYUGTA" is the server's reason code for a company without any receipt.
    const why = list.whyAmIEmpty === "NO_NYUGTA" ? " (the company has no receipts at all)" : "";
    throw new WebNotFoundError(`No receipt numbered "${params.receiptNumber}"${why}.`);
  }
  const data = await callPcapiJson<{ nyfej?: Row }>(login, "nyfej/get/byid", { id: hit.id }, RECEIPT_PROJECTION);

  let pdf: PdfResult = {};
  if (params.includePdf) {
    const buf = await callPcapiRaw(login, "nyfej/getpdf/byid", { id: hit.id }, { accept: "application/pdf" });
    pdf = handlePdf(params.receiptNumber, buf);
  }
  return JSON.stringify({ success: true, company: company.name, receipt: data.nyfej ?? hit, ...pdf });
}
