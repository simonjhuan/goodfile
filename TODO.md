# Pending fixes

## iOS to Android download start

When Android scans a QR code from an iOS sender, the receive flow checks
`/api/ping` before starting the download. The iOS file server currently only
serves `/download`, so the check fails and the user receives no immediate
"download started" status.

Planned fix:

1. Add an open, CORS-enabled `/api/ping` response to the iOS file server.
2. Start Android's download immediately after scanning, instead of blocking on
   the preflight check.
3. Show a persistent "download started" status and progress immediately.
