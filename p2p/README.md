# Private P2P workspace

`manbesi.lv/p2p/` is a two-device, Cloudflare Access-protected WebRTC workspace. Shared text updates live and files travel directly between the two browsers whenever the network allows it. The site root is intentionally blank.

## Connection and approval

- Cloudflare Access authenticates the owner before the page, signaling socket, or ICE configuration is available.
- The signaling Durable Object accepts at most two live sockets for the same verified Access subject.
- The first device is the approver. When a second device connects, both browsers derive a 48-bit safety code from the sorted WebRTC DTLS SHA-256 fingerprints.
- Text and files stay disabled until the codes are compared and the first device approves. Approval is authorized and broadcast by the Durable Object, not trusted to the browser UI alone.
- WebRTC encrypts the data channel in transit with DTLS. Cloudflare relays only the limited SDP/ICE setup messages and never receives file or shared-text contents.

## Files

- The receiver must choose **Save** before bytes are sent.
- Chromium uses the native File System Access save picker.
- Safari and Firefox use a same-origin service worker that streams the response into the browser download system.
- A bounded 250 MB in-memory fallback remains for browsers where neither direct-to-disk route works. Direct streams accept individual files up to 8 GB.
- The sender observes both WebRTC buffer pressure and receiver write acknowledgements, limiting unsaved in-flight data to roughly 1 MB.
- Dropped folders are converted locally to stored ZIP files. Folder ZIP construction is still capped at 250 MB because creating the archive itself happens before transfer.

## Network fallback

`GET /p2p/ice` returns authenticated, no-store ICE configuration. With no TURN secrets configured it returns Cloudflare STUN. When the Worker secrets `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` are present, the Worker exchanges the long-lived server-side token for one-hour TURN credentials and sends only those short-lived credentials to the authenticated browser.

## Operational limits

- Maximum two devices per verified owner identity.
- 20 signaling admissions per minute per private room.
- 120 signaling messages per 10 seconds, 32 KB maximum each, with closure after repeated protocol violations.
- Shared text is limited to 64 KB with a separate incoming update-rate check.
- Strict CSP, HSTS, same-origin isolation, no-referrer, no framing, no camera/microphone/geolocation/payment/USB permissions, and no-store responses under `/p2p/`.
