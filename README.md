# manbesi.lv

Cloudflare Worker serving the domain's public pages and private workspace:

- `/` and `/alus` — the Riga beer map, served through the `BEER_MAP` service binding.
- `/mdu` — the saved MDU autumn 2026 semester schedule, including its interactive calendar.
- `/p2p/` — the existing private Cloudflare Access-protected P2P workspace.

## Status API

Read the current value:

```bash
curl https://manbesi.lv/api/status
```

Update it with the Worker secret `STATUS_UPDATE_TOKEN`:

```bash
curl -X POST https://manbesi.lv/api/update \
  -H "Authorization: Bearer $MANBESI_STATUS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"text":"pirmdienas"}'
```

On the deployment Mac, the token is stored in Keychain under the service
`manbesi-status-api`. The repository helper reads it without printing it:

```bash
npm run status -- "pirmdienas"
```

The public page polls `/api/status` every two seconds and keeps the last known
value during temporary network failures.

## Development

```bash
npm install
npm run check
```

Local Worker development reads secrets from `.dev.vars`, which is ignored by
Git. Production secrets must be set with `wrangler secret put` and must never be
committed.
