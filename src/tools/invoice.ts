import { z } from "zod";
import { companyParam } from "../company-select.js";
import { getAgentLogin } from "../agent-auth.js";
import { callAgent, withoutSecrets } from "../agent/client.js";
import {
  createInvoiceRequest, reverseInvoiceRequest, registerPaymentRequest, deleteProformaRequest,
} from "../agent/requests.js";
import { attachPdf, isoDate } from "./issue-common.js";

// ============================================================
// create_invoice
// ============================================================

const invoiceLine = z.object({
  name: z.string().describe("Item name"),
  quantity: z.number().describe("Quantity"),
  unit: z.string().describe("Unit of quantity, as printed on the invoice, in the invoice's language"),
  netUnitPrice: z.number().describe("Net unit price"),
  vatRate: z.string().describe("VAT rate as Számlázz.hu expects it: a percentage ('27') or its tax code (e.g. 'TAM', 'AAM', 'EU', 'MAA')"),
  netAmount: z.number().describe("Net amount (quantity * net unit price)"),
  vatAmount: z.number().describe("VAT amount"),
  grossAmount: z.number().describe("Gross amount (net + VAT)"),
  comment: z.string().optional().describe("Item comment"),
});

export const createInvoiceSchema = z.object({
  company: companyParam,
  issueDate: isoDate("Issue date (YYYY-MM-DD)"),
  fulfillmentDate: isoDate("Fulfillment date (YYYY-MM-DD)"),
  dueDate: isoDate("Payment due date (YYYY-MM-DD)"),
  paymentMethod: z.string().describe("Payment method (bank transfer, cash, card, ...), as printed on the invoice, in the invoice's language"),
  currency: z.string().optional().describe("Currency (default: HUF)"),
  language: z.string().optional().describe("Invoice language: hu, en, de, it, ro, sk, hr, fr, es, cz, pl (default: hu)"),
  comment: z.string().optional().describe("Comment printed on the invoice"),
  orderNumber: z.string().optional().describe("Order number"),
  invoiceNumberPrefix: z.string().optional().describe("Invoice number prefix"),
  paid: z.boolean().optional().describe("Mark as paid"),
  proforma: z.boolean().optional().describe("Issue a proforma invoice instead"),
  advanceInvoice: z.boolean().optional().describe("Advance invoice"),
  finalInvoice: z.boolean().optional().describe("Final invoice"),
  correctionInvoice: z.boolean().optional().describe("Correction invoice"),
  correctedInvoiceNumber: z.string().optional().describe("Number of the invoice being corrected"),
  eInvoice: z.boolean().optional().describe("E-invoice (default: true)"),
  exchangeRateBank: z.string().optional().describe("Bank of the exchange rate for foreign currency (e.g. 'MNB')"),
  exchangeRate: z.number().optional().describe("Exchange rate for foreign currency (0 = current MNB rate)"),
  sellerBank: z.string().optional().describe("Seller's bank"),
  sellerBankAccount: z.string().optional().describe("Seller's bank account number"),
  replyToEmail: z.string().optional().describe("Reply-to address of the notification e-mail"),
  emailSubject: z.string().optional().describe("Subject of the notification e-mail"),
  emailText: z.string().optional().describe("Text of the notification e-mail"),
  signerName: z.string().optional().describe("Signer's name"),
  buyerName: z.string().describe("Buyer name"),
  buyerPostalCode: z.string().min(1).describe("Buyer postal code"),
  buyerCity: z.string().min(1).describe("Buyer city"),
  buyerAddress: z.string().min(1).describe("Buyer street address"),
  buyerEmail: z.string().optional().describe("Buyer e-mail"),
  sendEmail: z.boolean().optional().describe("E-mail the invoice notification to the buyer"),
  buyerTaxNumber: z.string().optional().describe("Buyer tax number"),
  buyerTaxStatus: z.union([z.literal(7), z.literal(6), z.literal(1), z.literal(0), z.literal(-1)]).optional()
    .describe("Buyer tax status: 7 = business outside the EU, 6 = EU business, 1 = Hungarian taxpayer, 0 = unknown, -1 = no tax number"),
  items: z.array(invoiceLine).min(1).max(500).describe("Invoice items"),
});

export async function createInvoice(params: z.infer<typeof createInvoiceSchema>): Promise<string> {
  const { login } = await getAgentLogin(params.company);
  const answer = await callAgent(createInvoiceRequest(login, params));
  return JSON.stringify({
    success: answer.ok,
    invoiceNumber: answer.documentNumber,
    net: answer.net,
    gross: answer.gross,
    buyerAccountUrl: answer.buyerAccountUrl,
    ...attachPdf(answer, answer.documentNumber),
  });
}

// ============================================================
// reverse_invoice
// ============================================================

export const reverseInvoiceSchema = z.object({
  company: companyParam,
  invoiceNumber: z.string().describe("Number of the invoice to reverse"),
  issueDate: isoDate("Issue date of the reversing invoice (YYYY-MM-DD)"),
  fulfillmentDate: isoDate("Fulfillment date of the reversing invoice (YYYY-MM-DD)"),
  eInvoice: z.boolean().optional().describe("E-invoice (default: true)"),
});

export async function reverseInvoice(params: z.infer<typeof reverseInvoiceSchema>): Promise<string> {
  const { login } = await getAgentLogin(params.company);
  const answer = await callAgent(reverseInvoiceRequest(login, params));
  return JSON.stringify({
    success: answer.ok,
    reversingInvoiceNumber: answer.documentNumber,
    net: answer.net,
    gross: answer.gross,
    ...attachPdf(answer, answer.documentNumber),
  });
}

// ============================================================
// register_payment
// ============================================================

export const registerPaymentSchema = z.object({
  company: companyParam,
  invoiceNumber: z.string().describe("Invoice number"),
  additive: z.boolean().optional().describe("true (default): earlier payments are kept; false: ALL are replaced"),
  payments: z.array(z.object({
    date: isoDate("Payment date (YYYY-MM-DD)"),
    method: z.string().describe("Payment method (bank transfer, cash, card, ...), in the invoice's language"),
    amount: z.number().describe("Amount"),
  })).min(1).max(5).describe("Payment entries (max 5 per invoice)"),
});

export async function registerPayment(params: z.infer<typeof registerPaymentSchema>): Promise<string> {
  const { login } = await getAgentLogin(params.company);
  const answer = await callAgent(registerPaymentRequest(login, params));
  return JSON.stringify({
    success: answer.ok,
    invoiceNumber: answer.documentNumber ?? params.invoiceNumber,
    net: answer.net,
    gross: answer.gross,
  });
}

// ============================================================
// delete_proforma
// ============================================================

export const deleteProformaSchema = z.object({
  company: companyParam,
  invoiceNumber: z.string().optional().describe("Proforma invoice number"),
  orderNumber: z.string().optional().describe("Order number (alternative; may delete several proformas)"),
});

export async function deleteProforma(params: z.infer<typeof deleteProformaSchema>): Promise<string> {
  if (!params.invoiceNumber && !params.orderNumber) {
    throw new Error("Give an invoice number or an order number.");
  }
  const { login } = await getAgentLogin(params.company);
  const answer = await callAgent(deleteProformaRequest(login, params));
  return JSON.stringify({
    success: answer.ok,
    message: answer.ok ? "Proforma deleted." : "Proforma deletion failed.",
    details: answer.document ? withoutSecrets(answer.document) : undefined,
  });
}
