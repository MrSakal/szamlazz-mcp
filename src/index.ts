#!/usr/bin/env node
/**
 * Számlázz.hu MCP server (stdio). Read tools use the Számlázz.hu web interface, issuing tools the
 * Agent API; both sign in with the username and password in ~/.szamlazz-mcp/config.json.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { errorMessage } from "./agent/client.js";
import { loadConfig } from "./config.js";
import { listCompaniesSchema, listCompanies } from "./tools/company.js";
import { listBankTransactionsSchema, listBankTransactions, getBankTransactionSchema, getBankTransaction } from "./tools/bank.js";
import {
  listInvoicesSchema, listInvoices, getInvoiceDataSchema, getInvoiceData,
  getInvoicePdfSchema, getInvoicePdf, getReceiptSchema, getReceipt,
} from "./tools/documents.js";
import {
  getInvoicePaymentsSchema, getInvoicePayments, getInvoiceActivitySchema, getInvoiceActivity,
  turnoverReportSchema, turnoverReport,
} from "./tools/invoice-extra.js";
import {
  listPartnersSchema, listPartners, getPartnerSchema, getPartner, listProductsSchema, listProducts,
  listReceiptsSchema, listReceipts, listRecurringInvoicesSchema, listRecurringInvoices,
  listDraftsSchema, listDrafts, getCompanyInfoSchema, getCompanyInfo,
} from "./tools/records.js";
import {
  createInvoiceSchema, createInvoice, reverseInvoiceSchema, reverseInvoice,
  registerPaymentSchema, registerPayment, deleteProformaSchema, deleteProforma,
} from "./tools/invoice.js";
import {
  createReceiptSchema, createReceipt, reverseReceiptSchema, reverseReceipt, sendReceiptSchema, sendReceipt,
} from "./tools/receipt.js";

/**
 * Tool hints for clients. Every write issues, reverses, deletes or e-mails a real document, so
 * clients should ask the user before running one.
 */
const HINTS = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
} as const;

/**
 * Turns a tool's JSON result into MCP content. A PDF travels as an embedded application/pdf
 * resource (the client gets the file itself, nothing is saved here) and is dropped from the JSON.
 */
function toContent(json: string): CallToolResult {
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { content: [{ type: "text", text: json }] };
  }
  const { pdfBase64, pdfName, ...rest } = result;
  if (typeof pdfBase64 !== "string") return { content: [{ type: "text", text: json }] };
  const uri = `szamlazz://pdf/${encodeURIComponent(String(pdfName ?? "document"))}.pdf`;
  const summary = { ...rest, pdf: { uri, mimeType: "application/pdf", bytes: Buffer.byteLength(pdfBase64, "base64") } };
  return {
    content: [
      { type: "text", text: JSON.stringify(summary) },
      { type: "resource", resource: { uri, mimeType: "application/pdf", blob: pdfBase64 } },
    ],
  };
}

/** The configured password, so an error message can never carry it; empty when no config is readable. */
function configuredSecrets(): string[] {
  try {
    const { password } = loadConfig();
    return password ? [password] : [];
  } catch {
    return [];
  }
}

function register<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  kind: keyof typeof HINTS,
  description: string,
  schema: z.ZodObject<Shape>,
  run: (params: z.infer<z.ZodObject<Shape>>) => Promise<string>,
): void {
  // The SDK sees a plain shape; run() gets the params typed by its own schema.
  const shape: z.ZodRawShape = schema.shape;
  server.tool(name, description, shape, HINTS[kind], async (params): Promise<CallToolResult> => {
    try {
      return toContent(await run(params as z.infer<z.ZodObject<Shape>>));
    } catch (error) {
      return { content: [{ type: "text", text: JSON.stringify({ error: errorMessage(error, configuredSecrets()) }) }], isError: true };
    }
  });
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "szamlazz-mcp",
    version: "1.0.0",
    description: "Számlázz.hu invoices, receipts and bank transactions, signed in with a Számlázz.hu user",
  });

  // Reads
  register(server, "list_companies", "read",
    "The companies the configured Számlázz.hu login can work in (read from Számlázz.hu), and which one the tools use " +
    "when no company is given. Switch per call: pass the company name or id in the other tools' company parameter.",
    listCompaniesSchema, () => listCompanies());
  register(server, "list_invoices", "read",
    "Invoices from the Számlázz.hu invoice lists: issued (outgoing), received (incoming) or both merged by issue date, " +
    "newest first. Filter by issue date range, payment status (paid, unpaid, overdue) and invoice number or partner name. " +
    "Pages are fetched automatically up to " +
    "limit; moreAvailable says whether anything was left out. Per row: direction, number, dates, partner, totals, paid, " +
    "outstanding. For a period, pass dateFrom/dateTo rather than raising limit.",
    listInvoicesSchema, listInvoices);
  register(server, "get_invoice_data", "read",
    "Data of an outgoing or incoming invoice by invoice number: seller, buyer, items, totals, amount paid and outstanding. Optionally the PDF too.",
    getInvoiceDataSchema, getInvoiceData);
  register(server, "get_invoice_pdf", "read",
    "PDF of an outgoing or incoming invoice by invoice number (for incoming ones, generated from the invoice data). " +
    "The PDF comes attached to the answer; nothing is saved to disk.",
    getInvoicePdfSchema, getInvoicePdf);
  register(server, "get_receipt", "read",
    "Data and PDF of a receipt by receipt number.",
    getReceiptSchema, getReceipt);
  register(server, "list_bank_transactions", "read",
    "Bank transactions for a period (id, reference, value date, amount, partner, direction), each with its matching " +
    "state (unmatched, partlySettled, fullySettled, excluded) and unmatched amount. Filter by matchStatus, e.g. toDo for " +
    "what still needs matching. Read from the Számlázz.hu web interface.",
    listBankTransactionsSchema, listBankTransactions);
  register(server, "get_bank_transaction", "read",
    "One bank transaction's matching: state, matched and unmatched amounts, the invoices it settled (number, amount, " +
    "how it was matched, by whom) and any invoices Számlázz.hu suggests. Only for the login's current company.",
    getBankTransactionSchema, getBankTransaction);

  register(server, "get_invoice_payments", "read",
    "Payments registered on an outgoing or incoming invoice: each entry's date, method, amount and who recorded it, " +
    "plus gross, paid and outstanding amounts.",
    getInvoicePaymentsSchema, getInvoicePayments);
  register(server, "get_invoice_activity", "read",
    "What happened to an invoice after issue: NAV Online Számla (and other system) submissions with their status, " +
    "e-mails sent with it, and payment reminders.",
    getInvoiceActivitySchema, getInvoiceActivity);
  register(server, "turnover_report", "read",
    "Turnover of documents this company issued in a period (the Számlázz.hu Forgalom report): item rows plus totals " +
    "per currency and per VAT rate. Filter by document type, buyer or product. Received invoices are not included.",
    turnoverReportSchema, turnoverReport);
  register(server, "list_partners", "read",
    "Partners (customers and suppliers) saved in Számlázz.hu: name, address, e-mail. Searchable; pages automatically.",
    listPartnersSchema, listPartners);
  register(server, "get_partner", "read",
    "One partner's full record by name or partnerId: tax number, addresses, e-mail, default payment terms.",
    getPartnerSchema, getPartner);
  register(server, "list_products", "read",
    "Products and services saved in Számlázz.hu: name, net unit price, unit, VAT rate. Searchable; pages automatically.",
    listProductsSchema, listProducts);
  register(server, "list_receipts", "read",
    "Issued receipts: number, date, amounts, payment method, reversal state. Searchable; pages automatically.",
    listReceiptsSchema, listReceipts);
  register(server, "list_recurring_invoices", "read",
    "Recurring invoice schedules set up in Számlázz.hu, with their original invoice and last run.",
    listRecurringInvoicesSchema, listRecurringInvoices);
  register(server, "list_drafts", "read",
    "Saved invoice drafts: name, buyer, amounts, when saved.",
    listDraftsSchema, listDrafts);
  register(server, "get_company_info", "read",
    "The company's own data and invoicing setup: name, tax numbers, address, default payment terms and currency, " +
    "invoice number prefixes, payment methods, and whether NAV Online Számla is connected. Useful before create_invoice.",
    getCompanyInfoSchema, getCompanyInfo);

  // Writes: each one changes real accounting documents
  register(server, "create_invoice", "write",
    "Issue a new invoice (normal, proforma, advance or correction invoice). The PDF comes attached to the answer.",
    createInvoiceSchema, createInvoice);
  register(server, "reverse_invoice", "write",
    "Reverse an invoice: issues the reversing invoice for the original.",
    reverseInvoiceSchema, reverseInvoice);
  register(server, "register_payment", "write",
    "Register payments on an invoice. At most 5 payment entries per invoice.",
    registerPaymentSchema, registerPayment);
  register(server, "delete_proforma", "write",
    "Delete a proforma invoice by invoice number or order number.",
    deleteProformaSchema, deleteProforma);
  register(server, "create_receipt", "write",
    "Issue a new receipt with items and an optional payment breakdown.",
    createReceiptSchema, createReceipt);
  register(server, "reverse_receipt", "write",
    "Reverse a receipt by receipt number.",
    reverseReceiptSchema, reverseReceipt);
  register(server, "send_receipt", "write",
    "E-mail a receipt to the given address.",
    sendReceiptSchema, sendReceipt);

  return server;
}

createServer()
  .connect(new StdioServerTransport())
  .then(() => console.error("szamlazz-mcp: ready on stdio"))
  .catch((error: unknown) => {
    console.error("szamlazz-mcp: failed to start:", error);
    process.exit(1);
  });
