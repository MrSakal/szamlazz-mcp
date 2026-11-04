import { z } from "zod";
import { handlePdf, type PdfResult } from "../config.js";
import type { AgentAnswer } from "../agent/client.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD date parameter. */
export const isoDate = (description: string) => z.string().regex(ISO_DATE, "Format: YYYY-MM-DD").describe(description);

/** The answer's PDF as an attachment, named after the document; nothing when there is none. */
export function attachPdf(answer: AgentAnswer, name: string | undefined): PdfResult {
  return answer.ok && answer.pdf && name ? handlePdf(name, answer.pdf) : {};
}
