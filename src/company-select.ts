/**
 * Picks the company a tool works in, from the list Számlázz.hu returns at sign-in: by its
 * Számlázz.hu id or its name; without one, the login's current company.
 */
import { z } from "zod";
import { getLogin } from "./config.js";
import { listWebCompanies, type WebCompany, type WebLogin } from "./web.js";

export const companyParam = z.string().optional().describe(
  "Company name (or part of it) or Számlázz.hu company id. Optional: defaults to the login's current company. " +
  "list_companies lists the choices."
);

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export interface SelectedCompany {
  /** The login, set to work in the chosen company. */
  login: WebLogin;
  company: WebCompany;
  /** Every company the login can work in. */
  companies: WebCompany[];
}

export async function selectCompany(query?: string): Promise<SelectedCompany> {
  const base = getLogin();
  const { currentCompanyId, companies } = await listWebCompanies(base);
  const q = query?.trim();

  let company: WebCompany | undefined;
  if (!q) {
    company = companies.find((c) => c.companyId === currentCompanyId) ?? { companyId: currentCompanyId, name: null };
  } else {
    const byId = /^\d+$/.test(q) ? companies.filter((c) => c.companyId === Number(q)) : [];
    const n = norm(q);
    const exact = companies.filter((c) => c.name && norm(c.name) === n);
    const partial = companies.filter((c) => c.name && norm(c.name).includes(n));
    const hits = byId.length ? byId : exact.length ? exact : partial;
    if (hits.length !== 1) {
      const list = companies.map((c) => `${c.name ?? "?"} (${c.companyId})`).join(", ");
      throw new Error(
        hits.length === 0
          ? `No company named or numbered "${q}" for this login. Available: ${list}`
          : `"${q}" matches several companies: ${hits.map((c) => `${c.name} (${c.companyId})`).join(", ")}. Give the company id.`
      );
    }
    company = hits[0];
  }

  // The current company needs no switch; asking for it explicitly would open a second session.
  const login: WebLogin = company.companyId === currentCompanyId ? base : { ...base, companyId: company.companyId };
  return { login, company, companies };
}
