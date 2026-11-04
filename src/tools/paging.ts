import { z } from "zod";
import { callPcapiJson, type WebLogin } from "../web.js";

/** Rows per request; some endpoints allow fewer (they say so in a 400 answer). */
const DEFAULT_PAGE_SIZE = 100;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

export const limitParam = z.number().int().min(1).max(MAX_LIMIT).optional()
  .describe(`Most rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Pages are fetched automatically until this is reached`);

type Row = Record<string, unknown>;

export interface PagedResult {
  rows: Row[];
  total: number | null;
  /** More matching rows exist than were returned. */
  more: boolean;
}

/**
 * Fetches a Számlázz.hu list endpoint page after page until `limit` rows are in hand or the list
 * ends. `body` gets page and pageSize added; `pick` takes the row out of each item.
 */
export async function fetchPages(
  login: WebLogin,
  endpoint: string,
  body: Row,
  projection: unknown,
  pick: (item: Row) => Row | undefined,
  limit: number,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<PagedResult> {
  const rows: Row[] = [];
  let total: number | null = null;
  let more = true;
  for (let page = 0; more && rows.length < limit; page++) {
    const answer = await callPcapiJson<{ items?: Row[]; totalSize?: unknown; hasNextPage?: boolean }>(
      login, endpoint, { ...body, page, pageSize }, projection);
    const items = answer.items ?? [];
    if (page === 0) {
      const t = answer.totalSize;
      total = typeof t === "number" ? t : t && typeof (t as Row).count === "number" ? (t as Row).count as number : null;
    }
    rows.push(...items.map(pick).filter((r): r is Row => !!r));
    more = typeof answer.hasNextPage === "boolean"
      ? answer.hasNextPage && items.length > 0
      : items.length === pageSize && (total === null || (page + 1) * pageSize < total);
  }
  return { rows: rows.slice(0, limit), total, more: more || rows.length > limit };
}

/** The usual answer fields for a capped list. */
export function listAnswer(result: PagedResult) {
  return {
    total: result.total,
    returned: result.rows.length,
    moreAvailable: result.more,
    ...(result.more ? { note: `More rows match than the ${result.rows.length} returned: narrow the search or raise limit (max ${MAX_LIMIT}).` } : {}),
  };
}
