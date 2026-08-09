# Completed mobile transfer fixes

## iOS to Android download start

Completed on 2026-08-09:

1. iOS now exposes a CORS-enabled `/api/ping` health check without revealing file metadata.
2. Android starts the download immediately after a QR scan instead of waiting for a preflight check.
3. The receiver shows a starting/progress state and keeps connection errors inside the app instead of opening Chrome.
4. iOS sends larger file chunks for better transfer throughput.

## Network safety note

Downloads remain protected by the one-time token in the QR URL. A Wi-Fi router that isolates devices (Guest Wi-Fi or AP isolation) cannot be bypassed by the app; the app now explains this clearly when it happens.
