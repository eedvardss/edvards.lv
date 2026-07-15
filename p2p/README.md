# P2P

Question: can `manbesi.lv` provide an owner-only live text/file workspace without uploading payloads anywhere?

The page is protected by Cloudflare Access. Two authenticated devices automatically meet through a bounded Durable Object signaling room, then exchange live text and file bytes over an encrypted WebRTC DataChannel. Signaling never carries text contents, filenames, or file bytes.

There are no pairing codes or transfer buttons. The first connected device owns the initial text state; after that, edits sync live with a deterministic last-write-wins rule. Files stay peer-to-peer and appear with a single save action on the receiving device. The app lives at `/p2p/`; the site root is intentionally blank.

## Local preview

From the repository root:

```sh
npm install
npx wrangler dev --local
```

Open the local URL at `/p2p/`. The interface renders locally, but signaling intentionally stays unavailable without a valid `ACCESS_CONFIG` secret and signed Cloudflare Access assertion. End-to-end testing happens on the protected deployment.

## Boundaries

- Payloads travel over an encrypted WebRTC peer connection and are not uploaded to the static website.
- The Durable Object is signaling-only, admits exactly two sockets for the verified owner identity, rejects stale sequences, and rate-limits malformed or excessive signaling.
- The Worker independently validates the Access JWT signature, issuer, audience, expiry, subject, and exact owner email before opening signaling.
- A public STUN server is used to discover a route between networks. There is no TURN relay, so some strict firewalls or carrier-grade NAT setups will fail.
- Incoming files are assembled in browser memory. The app caps each file at 250 MB.
