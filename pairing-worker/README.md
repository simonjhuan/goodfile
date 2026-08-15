# GoodFile 4-digit pairing service

This Cloudflare Worker is the rendezvous layer for sending a file from a PC browser to the GoodFile Android app.

## User flow

1. Android opens **Receive** and starts its local HTTP upload server.
2. The app registers the private-LAN upload URL and receives a four-digit code.
3. On a PC connected to the same Wi-Fi, open <https://goodfile-pair.maew0009.workers.dev>, enter the code, and choose a file.
4. The Worker consumes the code once and redirects the browser to Android. File bytes travel directly over the LAN; Cloudflare never receives the file.

Codes expire after five minutes and can be retried during that window if the browser cannot reach Android on the first attempt. Claim attempts are rate-limited. The Worker accepts only private IPv4 upload targets on port 8081 with the `/upload` path and an access token.

## Development

```sh
npm install
npm test
npm run typecheck
npm run deploy:dry
```

Deploy with `npm run deploy`. The Durable Object and rate-limit bindings are declared in `wrangler.jsonc`.

## Limitations

- PC and Android must be on the same Wi-Fi or hotspot and the network must allow device-to-device traffic.
- The Android app needs internet briefly to create the four-digit code. The QR/full local URL remains available as an offline fallback.
- A public or guest Wi-Fi network may isolate clients; use a phone hotspot when that happens.
