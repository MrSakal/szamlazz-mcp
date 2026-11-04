/**
 * Sign-in for the issuing tools (Számla Agent API). The Agent XSDs accept the Számlázz.hu
 * username + password in place of an Agent key, so the same login the read tools use works here
 * too. No Agent key is used anywhere.
 */
import { selectCompany } from "./company-select.js";
import type { AgentLogin } from "./agent/requests.js";
import type { WebCompany } from "./web.js";

export async function getAgentLogin(query?: string): Promise<{ login: AgentLogin; company: WebCompany }> {
  const { login, company, companies } = await selectCompany(query);
  // A password-signed Agent call carries no company id: Számlázz.hu picks the company itself.
  // With one company that is unambiguous; with several, a document could land in the wrong one.
  if (companies.length !== 1) {
    throw new Error(
      `This Számlázz.hu login reaches ${companies.length} companies. A password-signed Agent call does not say ` +
      `which company it issues in, so issuing is blocked. Use a Számlázz.hu user that belongs to one company only.`
    );
  }
  return { login: { username: login.username, password: login.password }, company };
}
