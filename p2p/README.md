# P2P

Question: can `manbesi.lv` host a useful private text/file transfer tool without adding an application server or uploading payloads anywhere?

This app uses a WebRTC data channel and a manual one-time handshake. It lives at `/p2p/`; the site root is intentionally blank.

## Run

From the repository root:

```sh
python3 -m http.server 4173
```

Open <http://localhost:4173/p2p/>.

To test the connection, open the page in two browsers or devices:

1. Device A creates an invitation and copies its code.
2. Device B pastes the invitation and uses it, then copies the generated response.
3. Device A pastes the response and uses it.
4. Send text or files in either direction.

## Boundaries

- Payloads travel over an encrypted WebRTC peer connection and are not uploaded to the static website.
- The pairing codes are not sent anywhere by this app. They contain short-lived connection metadata, so exchange them privately.
- A public STUN server is used to discover a route between networks. There is no TURN relay, so some strict firewalls or carrier-grade NAT setups will fail.
- Incoming files are assembled in browser memory. The app caps each file at 250 MB.
