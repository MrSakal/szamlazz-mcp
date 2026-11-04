/**
 * Agent API request documents, built from the tools' English inputs. Element names and their
 * order follow the official Számlázz.hu XSDs (https://www.szamlazz.hu/szamla/docs/xsds/...).
 * Every request signs in with the Számlázz.hu username and password (felhasznalo, jelszo).
 */
import { branch, leaf, xmlDocument, type XmlElement } from "./xml.js";

export interface AgentLogin {
  username: string;
  password: string;
}

/** One prepared call: the multipart field name the Agent API expects, and the XML document. */
export interface AgentRequest {
  action: string;
  xml: string;
}

const NAMESPACE_BASE = "http://www.szamlazz.hu/";

function request(action: string, root: XmlElement): AgentRequest {
  return { action, xml: xmlDocument(root, NAMESPACE_BASE + root.name) };
}

function credentials(login: AgentLogin): XmlElement[] {
  return [
    { name: "felhasznalo", value: login.username },
    { name: "jelszo", value: login.password },
  ];
}

// ============================================================
// Invoices
// ============================================================

export interface InvoiceLineInput {
  name: string;
  quantity: number;
  unit: string;
  netUnitPrice: number;
  vatRate: string;
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
  comment?: string;
}

export interface InvoiceInput {
  issueDate: string;
  fulfillmentDate: string;
  dueDate: string;
  paymentMethod: string;
  currency?: string;
  language?: string;
  comment?: string;
  orderNumber?: string;
  invoiceNumberPrefix?: string;
  paid?: boolean;
  proforma?: boolean;
  advanceInvoice?: boolean;
  finalInvoice?: boolean;
  correctionInvoice?: boolean;
  correctedInvoiceNumber?: string;
  eInvoice?: boolean;
  exchangeRateBank?: string;
  exchangeRate?: number;
  sellerBank?: string;
  sellerBankAccount?: string;
  replyToEmail?: string;
  emailSubject?: string;
  emailText?: string;
  signerName?: string;
  buyerName: string;
  buyerPostalCode: string;
  buyerCity: string;
  buyerAddress: string;
  buyerEmail?: string;
  sendEmail?: boolean;
  buyerTaxNumber?: string;
  buyerTaxStatus?: number;
  items: InvoiceLineInput[];
}

/** xmlszamla: a new invoice, answered with the invoice PDF inside the response XML. */
export function createInvoiceRequest(login: AgentLogin, p: InvoiceInput): AgentRequest {
  return request("action-xmlagentxmlfile", branch("xmlszamla", [
    branch("beallitasok", [
      ...credentials(login),
      leaf("eszamla", p.eInvoice ?? true),
      leaf("szamlaLetoltes", true),
      leaf("valaszVerzio", 2),
    ]),
    branch("fejlec", [
      leaf("keltDatum", p.issueDate),
      leaf("teljesitesDatum", p.fulfillmentDate),
      leaf("fizetesiHataridoDatum", p.dueDate),
      leaf("fizmod", p.paymentMethod),
      leaf("penznem", p.currency ?? "HUF"),
      leaf("szamlaNyelve", p.language ?? "hu"),
      leaf("megjegyzes", p.comment),
      leaf("arfolyamBank", p.exchangeRateBank),
      leaf("arfolyam", p.exchangeRate),
      leaf("rendelesSzam", p.orderNumber),
      leaf("elolegszamla", p.advanceInvoice),
      leaf("vegszamla", p.finalInvoice),
      leaf("helyesbitoszamla", p.correctionInvoice),
      leaf("helyesbitettSzamlaszam", p.correctedInvoiceNumber),
      leaf("dijbekero", p.proforma),
      leaf("szamlaszamElotag", p.invoiceNumberPrefix),
      leaf("fizetve", p.paid),
    ]),
    branch("elado", [
      leaf("bank", p.sellerBank),
      leaf("bankszamlaszam", p.sellerBankAccount),
      leaf("emailReplyto", p.replyToEmail),
      leaf("emailTargy", p.emailSubject),
      leaf("emailSzoveg", p.emailText),
      leaf("alairoNeve", p.signerName),
    ]),
    branch("vevo", [
      leaf("nev", p.buyerName),
      leaf("irsz", p.buyerPostalCode),
      leaf("telepules", p.buyerCity),
      leaf("cim", p.buyerAddress),
      leaf("email", p.buyerEmail),
      leaf("sendEmail", p.sendEmail),
      leaf("adoalany", p.buyerTaxStatus),
      leaf("adoszam", p.buyerTaxNumber),
    ]),
    branch("tetelek", p.items.map((line) => branch("tetel", [
      leaf("megnevezes", line.name),
      leaf("mennyiseg", line.quantity),
      leaf("mennyisegiEgyseg", line.unit),
      leaf("nettoEgysegar", line.netUnitPrice),
      leaf("afakulcs", line.vatRate),
      leaf("nettoErtek", line.netAmount),
      leaf("afaErtek", line.vatAmount),
      leaf("bruttoErtek", line.grossAmount),
      leaf("megjegyzes", line.comment),
    ]))),
  ]));
}

export interface ReverseInvoiceInput {
  invoiceNumber: string;
  issueDate: string;
  fulfillmentDate: string;
  eInvoice?: boolean;
}

/** xmlszamlast: a reversing ("storno") invoice for an existing one. */
export function reverseInvoiceRequest(login: AgentLogin, p: ReverseInvoiceInput): AgentRequest {
  return request("action-szamla_agent_st", branch("xmlszamlast", [
    branch("beallitasok", [
      ...credentials(login),
      leaf("eszamla", p.eInvoice ?? true),
      leaf("szamlaLetoltes", true),
      leaf("valaszVerzio", 2),
    ]),
    branch("fejlec", [
      leaf("szamlaszam", p.invoiceNumber),
      leaf("keltDatum", p.issueDate),
      leaf("teljesitesDatum", p.fulfillmentDate),
      leaf("tipus", "SS"),
    ]),
  ]));
}

export interface PaymentInput {
  invoiceNumber: string;
  additive?: boolean;
  payments: Array<{ date: string; method: string; amount: number }>;
}

/** xmlszamlakifiz: payments credited to an invoice. */
export function registerPaymentRequest(login: AgentLogin, p: PaymentInput): AgentRequest {
  return request("action-szamla_agent_kifiz", branch("xmlszamlakifiz", [
    branch("beallitasok", [
      ...credentials(login),
      leaf("szamlaszam", p.invoiceNumber),
      leaf("additiv", p.additive ?? true),
    ]),
    ...p.payments.map((pay) => branch("kifizetes", [
      leaf("datum", pay.date),
      leaf("jogcim", pay.method),
      leaf("osszeg", pay.amount),
    ])),
  ]));
}

/** xmlszamladbkdel: deletes a proforma by its number, or every proforma of an order number. */
export function deleteProformaRequest(login: AgentLogin, p: { invoiceNumber?: string; orderNumber?: string }): AgentRequest {
  return request("action-szamla_agent_dijbekero_torlese", branch("xmlszamladbkdel", [
    branch("beallitasok", credentials(login)),
    branch("fejlec", [
      leaf("szamlaszam", p.invoiceNumber),
      leaf("rendelesszam", p.orderNumber),
    ]),
  ]));
}

// ============================================================
// Receipts
// ============================================================

export interface ReceiptInput {
  prefix: string;
  paymentMethod: string;
  currency?: string;
  exchangeRateBank?: string;
  exchangeRate?: number;
  comment?: string;
  pdfTemplate?: string;
  buyerLedgerId?: string;
  callId?: string;
  includePdf?: boolean;
  items: Array<{
    name: string; itemId?: string; quantity: number; unit: string; netUnitPrice: number;
    netAmount: number; vatRate: string; vatAmount: number; grossAmount: number;
  }>;
  payments?: Array<{ method: string; amount: number; description?: string }>;
}

/** xmlnyugtacreate: a new receipt. */
export function createReceiptRequest(login: AgentLogin, p: ReceiptInput): AgentRequest {
  return request("action-szamla_agent_nyugta_create", branch("xmlnyugtacreate", [
    branch("beallitasok", [...credentials(login), leaf("pdfLetoltes", p.includePdf ?? false)]),
    branch("fejlec", [
      leaf("hivasAzonosito", p.callId),
      leaf("elotag", p.prefix),
      leaf("fizmod", p.paymentMethod),
      leaf("penznem", p.currency ?? "HUF"),
      leaf("devizaarf", p.exchangeRate),
      leaf("devizabank", p.exchangeRateBank),
      leaf("megjegyzes", p.comment),
      leaf("pdfSablon", p.pdfTemplate),
      leaf("fokonyvVevo", p.buyerLedgerId),
    ]),
    branch("tetelek", p.items.map((line) => branch("tetel", [
      leaf("megnevezes", line.name),
      leaf("azonosito", line.itemId),
      leaf("mennyiseg", line.quantity),
      leaf("mennyisegiEgyseg", line.unit),
      leaf("nettoEgysegar", line.netUnitPrice),
      leaf("afakulcs", line.vatRate),
      leaf("netto", line.netAmount),
      leaf("afa", line.vatAmount),
      leaf("brutto", line.grossAmount),
    ]))),
    p.payments && p.payments.length > 0 && branch("kifizetesek", p.payments.map((pay) => branch("kifizetes", [
      leaf("fizetoeszkoz", pay.method),
      leaf("osszeg", pay.amount),
      leaf("leiras", pay.description),
    ]))),
  ]));
}

/** xmlnyugtast: reverses a receipt. */
export function reverseReceiptRequest(login: AgentLogin, p: { receiptNumber: string; includePdf?: boolean }): AgentRequest {
  return request("action-szamla_agent_nyugta_storno", branch("xmlnyugtast", [
    branch("beallitasok", [...credentials(login), leaf("pdfLetoltes", p.includePdf ?? false)]),
    branch("fejlec", [leaf("nyugtaszam", p.receiptNumber)]),
  ]));
}

/** xmlnyugtasend: e-mails a receipt. */
export function sendReceiptRequest(login: AgentLogin, p: { receiptNumber: string; email: string }): AgentRequest {
  return request("action-szamla_agent_nyugta_send", branch("xmlnyugtasend", [
    branch("beallitasok", credentials(login)),
    branch("fejlec", [leaf("nyugtaszam", p.receiptNumber)]),
    branch("emailKuldes", [leaf("email", p.email)]),
  ]));
}
