# szamlazz-mcp

An [MCP](https://modelcontextprotocol.io/) server that lets Claude (or any MCP client) work with your
[Számlázz.hu](https://www.szamlazz.hu/) account: list and read invoices, fetch PDFs, read bank
transactions, and issue, reverse or e-mail invoices and receipts.

It signs in with your own Számlázz.hu username and password. No Agent API key is needed.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `list_companies` | read | Companies your login can work in, and which one is used by default |
| `list_invoices` | read | Outgoing invoices, newest first; search by invoice number or buyer; paid and outstanding amounts |
| `get_invoice_data` | read | One invoice: seller, buyer, items, totals, paid, outstanding; optionally its PDF |
| `get_invoice_pdf` | read | One invoice's PDF |
| `get_receipt` | read | One receipt's data, optionally its PDF |
| `list_bank_transactions` | read | Bank transactions for up to 366 days: amount, direction, partner, reference, value date |
| `create_invoice` | write | Issue an invoice (normal, proforma, advance, final, correction) |
| `reverse_invoice` | write | Reverse (storno) an invoice |
| `register_payment` | write | Record payments on an invoice |
| `delete_proforma` | write | Delete a proforma invoice |
| `create_receipt` | write | Issue a receipt |
| `reverse_receipt` | write | Reverse a receipt |
| `send_receipt` | write | E-mail a receipt |

Write tools are marked destructive, so MCP clients ask before running them. PDFs come back inside
the tool answer as embedded `application/pdf` resources; the server never writes them to disk.

Every tool takes an optional `company` parameter: a company name (or part of it) or its Számlázz.hu
id. Without it the login's current company is used.

## Requirements

- Node.js 20 or newer
- A Számlázz.hu user **without two-factor authentication**
- For the write tools: a user that belongs to **one company only** (see [How it works](#how-it-works))

## Install

```bash
git clone https://github.com/MrSakal/szamlazz-mcp.git
cd szamlazz-mcp
npm ci
npm run build
```

## Configure

The server reads one file, `~/.szamlazz-mcp/config.json`
(Windows: `C:\Users\<you>\.szamlazz-mcp\config.json`). Copy the example and fill it in:

```bash
mkdir -p ~/.szamlazz-mcp && cp config.example.json ~/.szamlazz-mcp/config.json
```

```json
{
  "username": "<SZAMLAZZ_EMAIL>",
  "password": "<SZAMLAZZ_PASSWORD>"
}
```

That is all: companies, names and ids are read from Számlázz.hu after sign-in.

Then register the server with your client.

**Claude Code**

```bash
claude mcp add szamlazz -- node /absolute/path/to/szamlazz-mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "szamlazz": {
      "command": "node",
      "args": ["/absolute/path/to/szamlazz-mcp/dist/index.js"]
    }
  }
}
```

Restart the client, then ask: *"Which companies can my Számlázz.hu login reach?"*

## How it works

**Read tools** sign in to the Számlázz.hu web interface the way a browser does and call the same
internal endpoints its pages use (`/szamla/pcapi/...`). Only a fixed list of read-only endpoints can
be called (`ALLOWED_PCAPI` in `src/web.ts`); everything else is refused before a request is made.
The session lives in memory only.

**Write tools** use the documented [Számla Agent API](https://docs.szamlazz.hu/). Its XML schemas
accept a username and password (`felhasznalo`, `jelszo`) in place of an Agent key, so the same
login works. A password-signed Agent call does not say which company it is for, so the write tools
refuse to run when the login reaches more than one company, rather than risk issuing in the wrong one.

Network traffic goes to `https://www.szamlazz.hu` only. Nothing is collected or sent anywhere else.

## Security and risks

- The password sits **in plain text** in `config.json` and gives full access to the account. The
  file is created owner-only (`0600`); keep it out of backups and sync folders. `.gitignore`
  excludes it.
- The password is sent only to `https://www.szamlazz.hu`, never logged and never returned by a tool.
- The read endpoints are **undocumented**: Számlázz.hu can change them without notice, and the read
  tools will then fail until updated.
- Automated use of the web interface may not be covered by the Számlázz.hu terms of service. Check
  them before relying on this.
- The write tools have not been tested against a live account by the author. Try them on a test
  account first.

## License

[MIT](LICENSE)
