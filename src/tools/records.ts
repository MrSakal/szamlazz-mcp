/**
 * Read tools for the account's records: partners, products, receipts, recurring invoices, drafts,
 * and the company's own settings. Same web backend calls as the corresponding Számlázz.hu pages.
 */
import { z } from "zod";
import { companyParam, selectCompany } from "../company-select.js";
import { callPcapiJson } from "../web.js";
import { num, str } from "./documents.js";
import { fetchPages, limitParam, listAnswer, DEFAULT_LIMIT } from "./paging.js";

type Row = Record<string, unknown>;
const searchParam = (what: string) => z.string().optional().describe(`Text to search for in ${what} (default: all)`);

// ============================================================
// Partners
// ============================================================

export const listPartnersSchema = z.object({ company: companyParam, search: searchParam("partner names and addresses"), limit: limitParam });

export async function listPartners(params: z.infer<typeof listPartnersSchema>): Promise<string> {
  const { login, company } = await selectCompany(params.company);
  const limit = params.limit ?? DEFAULT_LIMIT;
  const r = await fetchPages(login, "partner/list/bykey", { searchKey: params.search?.trim() || undefined },
    { items: { partner: "base" }, totalSize: "all" }, (i) => i.partner as Row | undefined, limit);
  return JSON.stringify({
    success: true,
    company: company.name,
    ...listAnswer(r),
    partners: r.rows.map((p) => ({
      partnerId: num(p.id), name: str(p.name), postalCode: str(p.irsz), city: str(p.city), address: str(p.addr), email: str(p.email),
    })),
  });
}

export const getPartnerSchema = z.object({
  company: companyParam,
  partner: z.string().min(1).describe("Partner name (or a unique part of it) or partnerId from list_partners"),
});

export async function getPartner(params: z.infer<typeof getPartnerSchema>): Promise<string> {
  const { login } = await selectCompany(params.company);
  const q = params.partner.trim();
  let id: number;
  if (/^\d+$/.test(q)) {
    id = Number(q);
  } else {
    const r = await fetchPages(login, "partner/list/bykey", { searchKey: q },
      { items: { partner: "base" }, totalSize: "all" }, (i) => i.partner as Row | undefined, 20);
    const exact = r.rows.filter((p) => String(p.name ?? "").toLowerCase() === q.toLowerCase());
    const hits = exact.length ? exact : r.rows;
    if (hits.length !== 1) {
      throw new Error(hits.length === 0
        ? `No partner matches "${q}".`
        : `"${q}" matches several partners: ${hits.slice(0, 10).map((p) => `${p.name} (${p.id})`).join(", ")}. Give the partnerId.`);
    }
    id = hits[0].id as number;
  }
  const answer = await callPcapiJson<{ partner?: Row }>(login, "partner/get/byid", { id }, { partner: "edit" });
  const p = answer.partner;
  if (!p) throw new Error(`No partner with id ${id}.`);
  return JSON.stringify({
    success: true,
    partner: {
      partnerId: num(p.id),
      name: str(p.name),
      taxNumber: str(p.taxNumber),
      taxPayerType: str(p.taxPayer),
      email: str(p.email),
      address: { postalCode: str(p.irsz), city: str(p.city), address: str(p.addr) },
      postalAddress: str(p.postName) || str(p.postAddr)
        ? { name: str(p.postName), postalCode: str(p.postIrsz), city: str(p.postCity), address: str(p.postAddr) }
        : undefined,
      defaultPaymentMethod: str(p.defaultFizMod),
      defaultCurrency: str(p.defaultDeviza),
      defaultPaymentDays: num(p.defaultFizHatDay),
      paymentDaysFromFulfillment: p.fizHatFromTelj === true,
    },
  });
}

// ============================================================
// Products
// ============================================================

export const listProductsSchema = z.object({ company: companyParam, search: searchParam("product names"), limit: limitParam });

export async function listProducts(params: z.infer<typeof listProductsSchema>): Promise<string> {
  const { login, company } = await selectCompany(params.company);
  const limit = params.limit ?? DEFAULT_LIMIT;
  const r = await fetchPages(login, "cikk/list/bykey", { searchKey: params.search?.trim() || undefined },
    { items: { cikk: "base" }, totalSize: "all" }, (i) => i.cikk as Row | undefined, limit);
  return JSON.stringify({
    success: true,
    company: company.name,
    ...listAnswer(r),
    products: r.rows.map((c) => ({
      productId: num(c.id), name: str(c.name), netUnitPrice: num(c.nettEgysAr), quantity: num(c.menny),
      unit: str(c.meEgys), vatRate: num(c.afaK) ?? str(c.afaK), description: str(c.desc),
    })),
  });
}

// ============================================================
// Receipts
// ============================================================

export const listReceiptsSchema = z.object({ company: companyParam, search: searchParam("receipt numbers and comments"), limit: limitParam });

export async function listReceipts(params: z.infer<typeof listReceiptsSchema>): Promise<string> {
  const { login, company } = await selectCompany(params.company);
  const limit = params.limit ?? DEFAULT_LIMIT;
  const r = await fetchPages(login, "nyfej/list/all", { searchKey: params.search?.trim() || undefined },
    { items: { nyfej: "list" }, hasNextPage: "all", totalSize: "all" }, (i) => i.nyfej as Row | undefined, limit);
  return JSON.stringify({
    success: true,
    company: company.name,
    ...listAnswer(r),
    receipts: r.rows.map((n) => ({
      receiptNumber: str(n.nyugtaszam),
      issueDate: str(n.keltDat),
      net: num(n.netto),
      gross: num(n.brutto) ?? num(n.brutOssz),
      currency: str(n.deviza),
      paymentMethod: str(n.fizMod),
      orderNumber: str(n.rendelesSzam),
      comment: str(n.desc),
      reversed: n.isStornozott === true,
      isReversal: n.isStornozo === true,
    })),
  });
}

// ============================================================
// Recurring invoices and drafts
// ============================================================

export const listRecurringInvoicesSchema = z.object({ company: companyParam, search: searchParam("recurring invoices"), limit: limitParam });

export async function listRecurringInvoices(params: z.infer<typeof listRecurringInvoicesSchema>): Promise<string> {
  const { login, company } = await selectCompany(params.company);
  const limit = params.limit ?? DEFAULT_LIMIT;
  const r = await fetchPages(login, "szfejrepeat/list/bykey",
    { searchKey: params.search?.trim() || undefined, orderByType: "ORDERBY_NEXTDAT", asc: true },
    { items: { szfejRepeat: "base", originalSzfej: "szfejrepeatlist", madeSzfejs: "none", lastSzfejRepeatLog: "all" }, totalSize: "all" },
    (i) => i.szfejRepeat ? { ...(i.szfejRepeat as Row), original: i.originalSzfej, lastLog: i.lastSzfejRepeatLog } : undefined, limit);
  return JSON.stringify({
    success: true,
    company: company.name,
    ...listAnswer(r),
    // Field names are Számlázz.hu's own; empty values are left out.
    recurringInvoices: r.rows.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== null && v !== undefined && v !== ""))),
  });
}

export const listDraftsSchema = z.object({ company: companyParam, search: searchParam("drafts"), limit: limitParam });

export async function listDrafts(params: z.infer<typeof listDraftsSchema>): Promise<string> {
  const { login, company } = await selectCompany(params.company);
  const limit = params.limit ?? DEFAULT_LIMIT;
  const r = await fetchPages(login, "piszkozat/list/bykey",
    { searchKey: params.search?.trim() || undefined, orderByType: "ORDERBY_CREATDAT", asc: false },
    "default", (i) => i.piszkozat as Row | undefined, limit);
  return JSON.stringify({
    success: true,
    company: company.name,
    ...listAnswer(r),
    drafts: r.rows.map((d) => ({
      draftId: num(d.id), name: str(d.name), buyer: str(d.vevo), fulfillmentDate: str(d.teljDat),
      savedAt: str(d.rogzDat), net: num(d.netto), gross: num(d.brutto), currency: str(d.currency),
    })),
  });
}

// ============================================================
// Company info
// ============================================================

export const getCompanyInfoSchema = z.object({ company: companyParam });

export async function getCompanyInfo(params: z.infer<typeof getCompanyInfoSchema>): Promise<string> {
  const { login } = await selectCompany(params.company);
  const [ceg, prefixes, methods, nav] = await Promise.all([
    callPcapiJson<{ ceg?: Row }>(login, "ceg/get/me", {}, { ceg: "all", recommendUsr: "none", szfejYears: "none", nyfejYears: "none" }),
    fetchPages(login, "szamlatomb/list/all", {}, { items: { szamlaTomb: "all", mbCeg: "name" } }, (i) => i.szamlaTomb as Row | undefined, 500),
    callPcapiJson<{ items?: Array<{ cegFizMod?: Row }> }>(login, "cegfizmod/list/all", { withDefaults: true }),
    callPcapiJson<Row>(login, "navconnection/get/me", {}),
  ]);
  const c = ceg.ceg ?? {};
  // Only listed fields leave this function: the backend answers carry internal keys, and the NAV
  // answer carries the NAV technical user's credentials, which must never be returned.
  return JSON.stringify({
    success: true,
    company: {
      name: str(c.companyName),
      legalForm: str(c.cegForma),
      taxNumber: str(c.taxNumber),
      euTaxNumber: str(c.taxNumberEU),
      registrationNumber: str(c.cegjegyzekSzam),
      address: [str(c.addr1), str(c.addr2)].filter(Boolean).join(", ") || undefined,
      postalAddress: [str(c.postIrsz), str(c.postCity), str(c.postAddr)].filter(Boolean).join(" ") || undefined,
      email: str(c.email),
      phone: str(c.tel),
      cashAccountingVat: c.penzforgalmiElszamolas === true,
      currentYear: num(c.targyEv),
      testAccount: c.teszt === true,
    },
    invoiceDefaults: {
      paymentMethod: str(c.defaultFizMod),
      paymentDays: num(c.defaultFizHatNap),
      currency: str(c.defaultDeviza),
      language: str(c.defaultLang),
      exchangeRateBank: str(c.defaultArfBank),
      vatRate: num(c.defaultAfaK) ?? str(c.defaultAfaK),
    },
    invoiceNumberPrefixes: prefixes.rows.map((t) => ({
      prefix: str(t.prefix), type: str(t.type), description: str(t.desc), enabled: t.enabled === true, blockedByNav: t.blockedByNav === true,
    })),
    paymentMethods: (methods.items ?? []).map((m) => m.cegFizMod).filter((m): m is Row => !!m)
      .map((m) => ({ name: str(m.value), markedPaidOnIssue: m.kiegyenlitett === true })),
    navOnlineInvoice: {
      connected: nav.navReady === true,
      invoiceConnectionStatus: num(nav.navConnectionStatus),
      receiptConnectionStatus: num(nav.navNyugtaConnectionStatus),
    },
  });
}
