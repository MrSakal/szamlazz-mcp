import { z } from "zod";
import { getLogin } from "../config.js";
import { listWebCompanies } from "../web.js";

export const listCompaniesSchema = z.object({});

/**
 * The companies the configured Számlázz.hu login can work in, read from Számlázz.hu at sign-in.
 * Never returns the password.
 */
export async function listCompanies(): Promise<string> {
  const login = getLogin();
  const { currentCompanyId, companies } = await listWebCompanies(login);
  return JSON.stringify({
    username: login.username,
    companies: companies.map((c) => ({
      companyId: c.companyId,
      name: c.name,
      usedWhenNoCompanyGiven: c.companyId === currentCompanyId,
    })),
    switching: "Per call, with the company parameter (company name or id). There is no lasting switch.",
    issuing: companies.length === 1
      ? "allowed"
      : "blocked: a password-signed issue call does not say which company it is for; use a single-company user",
  });
}
