import { z } from "zod";
import { companyParam } from "../company-select.js";
import { getAgentLogin } from "../agent-auth.js";
import { callAgent, findValue, withoutSecrets } from "../agent/client.js";
import { createReceiptRequest, reverseReceiptRequest, sendReceiptRequest } from "../agent/requests.js";
import { attachPdf } from "./issue-common.js";

const includePdf = z.boolean().optional().describe("Include the PDF in the answer (default: false)");

// ============================================================
// create_receipt
// ============================================================

export const createReceiptSchema = z.object({
  company: companyParam,
  prefix: z.string().describe("Receipt number prefix (required, e.g. 'NYGTA-2024-')"),
  paymentMethod: z.string().describe("Payment method (cash, card, ...), as printed, in the receipt's language"),
  currency: z.string().optional().describe("Currency (default: HUF)"),
  exchangeRateBank: z.string().optional().describe("Bank of the exchange rate (non-HUF)"),
  exchangeRate: z.number().optional().describe("Exchange rate"),
  comment: z.string().optional().describe("Comment"),
  pdfTemplate: z.string().optional().describe("PDF template id"),
  buyerLedgerId: z.string().optional().describe("Buyer's general ledger id"),
  callId: z.string().optional().describe("Call id (prevents duplicates)"),
  includePdf,
  items: z.array(z.object({
    name: z.string().describe("Item name"),
    itemId: z.string().optional().describe("Item identifier"),
    quantity: z.number().describe("Quantity"),
    unit: z.string().describe("Unit of quantity, as printed on the receipt, in the receipt's language"),
    netUnitPrice: z.number().describe("Net unit price"),
    netAmount: z.number().describe("Net amount"),
    vatRate: z.string().describe("VAT rate as Számlázz.hu expects it: a percentage ('27') or its tax code (e.g. 'TAM', 'ÁKK')"),
    vatAmount: z.number().describe("VAT amount"),
    grossAmount: z.number().describe("Gross amount"),
  })).min(1).max(500).describe("Receipt items"),
  payments: z.array(z.object({
    method: z.string().describe("Payment instrument (cash, card, voucher, ...), in the receipt's language"),
    amount: z.number().describe("Amount"),
    description: z.string().optional().describe("Payment instrument description"),
  })).optional().describe("Payment breakdown (optional)"),
});

export async function createReceipt(params: z.infer<typeof createReceiptSchema>): Promise<string> {
  const { login } = await getAgentLogin(params.company);
  const answer = await callAgent(createReceiptRequest(login, params));
  const number = answer.document ? findValue(answer.document, "nyugtaszam") : undefined;
  const receiptNumber = number === undefined || number === null || number === "" ? undefined : String(number);
  return JSON.stringify({
    success: answer.ok,
    receiptNumber,
    ...(params.includePdf ? attachPdf(answer, receiptNumber) : {}),
  });
}

// ============================================================
// reverse_receipt
// ============================================================

export const reverseReceiptSchema = z.object({
  company: companyParam,
  receiptNumber: z.string().describe("Number of the receipt to reverse"),
  includePdf,
});

export async function reverseReceipt(params: z.infer<typeof reverseReceiptSchema>): Promise<string> {
  const { login } = await getAgentLogin(params.company);
  const answer = await callAgent(reverseReceiptRequest(login, params));
  return JSON.stringify({
    success: answer.ok,
    message: answer.ok ? "Receipt reversed." : "Receipt reversal failed.",
    ...(params.includePdf ? attachPdf(answer, `${params.receiptNumber}-reversal`) : {}),
  });
}

// ============================================================
// send_receipt
// ============================================================

export const sendReceiptSchema = z.object({
  company: companyParam,
  receiptNumber: z.string().describe("Number of the receipt to send"),
  email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid e-mail format").describe("Recipient e-mail address"),
});

export async function sendReceipt(params: z.infer<typeof sendReceiptSchema>): Promise<string> {
  const { login } = await getAgentLogin(params.company);
  const answer = await callAgent(sendReceiptRequest(login, params));
  return JSON.stringify({
    success: answer.ok,
    message: answer.ok ? `Receipt ${params.receiptNumber} sent to ${params.email}.` : "Sending the receipt failed.",
    details: answer.document ? withoutSecrets(answer.document) : undefined,
  });
}
