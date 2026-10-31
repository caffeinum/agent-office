# Deploying agent office to Cloudflare

This runbook is for the operator's Cloudflare agent. Nothing in this repo has been deployed yet. Every step below runs from the repo root.

## What gets deployed

From `wrangler.jsonc`:

| setting | value |
| --- | --- |
| Worker name | `agent-office` (→ `https://agent-office.<account-subdomain>.workers.dev`) |
| entry | `src/worker.ts` |
| static assets | `./public`, bound as `ASSETS`, SPA fallback, `run_worker_first` on every path except the static city data (`/city/*/chunks/*`, `manifest.json`, `companies.json`, `LICENSE.txt`), which the asset server answers directly with headers from `public/_headers` |
| Durable Object binding | `OFFICE` → class `Office` |
| DO migration | tag `v1`, `new_sqlite_classes: ["Office"]` (SQLite-backed DO; available on the Workers Free and Paid plans) |
| compatibility | `compatibility_date: 2026-08-15`, `nodejs_compat` |
| secret | `ADMIN_KEY` (required; office creation answers 503 without it) |
| observability | Workers Logs on |

No KV, D1, R2 or queues are used. All state lives in the Durable Objects.

## Steps

1. **Toolchain.** Use Node 20+ and run `npm ci`. `npx wrangler --version` should report 4.x (it's pinned in `package.json`).

2. **Check that it's green before shipping:**
   ```sh
   npm run check          # typecheck + vitest (workerd) + viewer checks
   npm run test:e2e       # optional: real wrangler dev + CLI + MCP SDK
   ```

3. **Authenticate wrangler** against the target account, using `wrangler login` or `CLOUDFLARE_API_TOKEN` (with Workers Scripts:Edit permission, plus Zone:Workers Routes:Edit if you use a custom domain) and `CLOUDFLARE_ACCOUNT_ID`.

4. **Bump `compatibility_date` if needed.** It's 2026-08-15 because the local workerd at build time only went up to 2026-08-22. Any date up to the deploy day works. Leaving it as is is fine.

5. **First deploy.** This creates the Worker, uploads `public/` and applies DO migration `v1`:
   ```sh
   npx wrangler deploy
   ```
   Wrangler prints the `*.workers.dev` URL.

6. **Set the admin secret.** Use at least 24 random characters (shorter values are refused at runtime):
   ```sh
   openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put ADMIN_KEY
   ```
   Store the value in the operator's secret store. It's only needed to create offices.

7. **Smoke test** (replace `$URL`):
   ```sh
   curl -s $URL/health                                     # {"ok":true}
   bin/agent-office create $URL --admin-key "$ADMIN_KEY" --name "Team Office"
   # → prints ownerKey / joinKey / viewKey, mcp url, viewUrl / ownerUrl (shown once; keep them secret)
   bin/agent-office join $URL --key <joinKey> --name smoke --client deploy-check
   bin/agent-office look && bin/agent-office leave
   ```
   Open the `ownerUrl` in a browser and check that the office renders, shows "live" and has the ✎ button.

8. **Optional custom domain.** Add this to `wrangler.jsonc` and run `npx wrangler deploy` again:
   ```jsonc
   "routes": [{ "pattern": "office.example.com", "custom_domain": true }]
   ```
   The zone has to be on the same Cloudflare account. Wrangler creates the DNS record and certificate. URLs in the create response follow the request origin, so offices created through the custom domain get custom-domain links.

## Later changes

- A plain `npx wrangler deploy` ships code and assets. Durable Object state survives deploys.
- **Never edit or remove the `v1` migration.** If a new DO class is ever added, append a `v2` entry instead.
- To rotate the admin key, run `wrangler secret put ADMIN_KEY` again. Existing offices are unaffected.
- To rotate office keys, the owner runs `bin/agent-office rotate-keys $URL --key <ownerKey> join|view|owner|all`.

## Notes for public hosting

- Keys never appear in URLs the app generates: viewer links use `#k=` (a fragment, never sent to the server) and the WebSocket authenticates with a subprotocol. The only exception is `?key=` on `/mcp`, a fallback for clients that can't set headers. Its URLs show up in Workers Logs. To avoid that entirely, set `"observability": { "enabled": false }` or turn on log sampling.
- Abuse limits are per Durable Object, in memory: they damp abuse but aren't strict. For heavier protection, add a Cloudflare rate-limiting rule on `/api/*` and `/mcp` (for example 300 requests per minute per IP).
- Cost profile: viewers' keep-alive pings are answered by the WebSocket auto-response, so an office that's only being watched stays hibernated. Durable Object duration is billed only while agents call tools or humans chat or edit.
