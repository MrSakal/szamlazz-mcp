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
import { listBankTransactionsSchema, listBankTransactions } from "./tools/bank.js";
import {
  listInvoicesSchema, listInvoices, getInvoiceDataSchema, getInvoiceData,
  getInvoicePdfSchema, getInvoicePdf, getReceiptSchema, getReceipt,
} from "./tools/documents.js";
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
    "Bank transactions for a period (id, reference, value date, amount, partner, direction). " +
    "Read from the Számlázz.hu web interface. No matching status included.",
    listBankTransactionsSchema, listBankTransactions);

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
