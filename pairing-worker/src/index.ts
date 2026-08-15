import { DurableObject } from "cloudflare:workers";

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_JSON_BYTES = 4096;
const CODE_RE = /^\d{4}$/;

type StoredSession = {
  upload_url: string;
  owner_hash: string;
  expires_at: number;
  claimed_at: number | null;
};

type ResolveResult =
  | { status: "ready"; targetUrl: string; targetType: "upload" | "download" }
  | { status: "missing" | "expired" };

export class PairingRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS session (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          upload_url TEXT NOT NULL,
          owner_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          claimed_at INTEGER
        )
      `);
    });
  }

  async reserve(uploadUrl: string, ownerHash: string, expiresAt: number): Promise<boolean> {
    const now = Date.now();
    const current = this.read();
    if (current && current.expires_at > now && current.claimed_at === null) return false;

    this.ctx.storage.sql.exec("DELETE FROM session");
    this.ctx.storage.sql.exec(
      "INSERT INTO session (singleton, upload_url, owner_hash, expires_at, claimed_at) VALUES (1, ?, ?, ?, NULL)",
      uploadUrl,
      ownerHash,
      expiresAt,
    );
    await this.ctx.storage.setAlarm(expiresAt);
    return true;
  }

  resolve(): ResolveResult {
    const row = this.read();
    if (!row) return { status: "missing" };
    if (row.expires_at <= Date.now()) {
      this.ctx.storage.sql.exec("DELETE FROM session");
      return { status: "expired" };
    }
    // A redirect only proves that the PC asked to open Android. It does not
    // prove that Chrome reached the private-LAN server, so keep the code
    // reusable until expiry. This lets the user retry after a transient Wi-Fi,
    // firewall, or browser navigation failure without exposing a new target.
    if (row.claimed_at === null) {
      this.ctx.storage.sql.exec("UPDATE session SET claimed_at = ? WHERE singleton = 1", Date.now());
    }
    return { status: "ready", targetUrl: row.upload_url, targetType: isDownloadUrl(row.upload_url) ? "download" : "upload" };
  }

  async status(ownerSecret: string): Promise<{ status: "waiting" | "claimed" | "expired" | "unauthorized" }> {
    const row = this.read();
    if (!row || row.expires_at <= Date.now()) return { status: "expired" };
    if (!(await secureEqual(await sha256(ownerSecret), row.owner_hash))) return { status: "unauthorized" };
    return { status: row.claimed_at === null ? "waiting" : "claimed" };
  }

  async cancel(ownerSecret: string): Promise<boolean> {
    const row = this.read();
    if (!row || !(await secureEqual(await sha256(ownerSecret), row.owner_hash))) return false;
    this.ctx.storage.sql.exec("DELETE FROM session");
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  override async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM session");
  }

  private read(): StoredSession | null {
    return this.ctx.storage.sql.exec<StoredSession>(
      "SELECT upload_url, owner_hash, expires_at, claimed_at FROM session WHERE singleton = 1",
    ).toArray()[0] ?? null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
        return withCors(new Response(null, { status: 204 }));
      }
      if (request.method === "POST" && url.pathname === "/api/pair") {
        return withCors(await createPair(request, env, url.origin));
      }
      const statusMatch = url.pathname.match(/^\/api\/pair\/(\d{4})$/);
      if (statusMatch && request.method === "POST") {
        return withCors(await pairAction(request, env, statusMatch[1]!));
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "goodfile-pair" });
      }
      if (request.method === "GET") {
        const pathCode = url.pathname.match(/^\/(\d{4})$/)?.[1];
        const queryCode = url.pathname === "/" ? url.searchParams.get("code") : null;
        const code = pathCode ?? queryCode;
        if (code !== null) return await claimCode(request, env, code);
        if (url.pathname === "/") return html(homePage());
      }
      return html(errorPage("Not found", "Open the GoodFile pairing page and enter the 4-digit code again."), 404);
    } catch (error) {
      console.error(JSON.stringify({
        message: "pairing request failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return json({ error: "Service temporarily unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;

async function createPair(request: Request, env: Env, origin: string): Promise<Response> {
  const body = await readJsonLimited(request);
  const uploadUrl = typeof body.uploadUrl === "string" ? normalizeUploadUrl(body.uploadUrl) : null;
  const downloadUrl = typeof body.downloadUrl === "string" ? normalizeDownloadUrl(body.downloadUrl) : null;
  const targetUrl = uploadUrl ?? downloadUrl;
  if (!targetUrl) return json({ error: "A private-LAN uploadUrl or downloadUrl with a token is required" }, 400);

  const ownerSecret = randomToken(24);
  const ownerHash = await sha256(ownerSecret);
  const expiresAt = Date.now() + CODE_TTL_MS;

  for (let attempt = 0; attempt < 40; attempt++) {
    const code = randomCode();
    const room = env.PAIRING_ROOM.getByName(code);
    if (await room.reserve(targetUrl, ownerHash, expiresAt)) {
      return json({
        code,
        ownerSecret,
        expiresAt,
        claimUrl: `${origin}/${code}`,
      }, 201);
    }
  }
  return json({ error: "No pairing code is currently available; try again" }, 503);
}

async function pairAction(request: Request, env: Env, code: string): Promise<Response> {
  const body = await readJsonLimited(request);
  const ownerSecret = typeof body.ownerSecret === "string" ? body.ownerSecret : "";
  if (!ownerSecret || ownerSecret.length > 128) return json({ error: "Invalid owner secret" }, 400);
  const room = env.PAIRING_ROOM.getByName(code);
  if (body.action === "status") return json(await room.status(ownerSecret));
  if (body.action === "cancel") {
    const cancelled = await room.cancel(ownerSecret);
    return json({ status: cancelled ? "cancelled" : "unauthorized" }, cancelled ? 200 : 403);
  }
  return json({ error: "Invalid action" }, 400);
}

async function claimCode(request: Request, env: Env, rawCode: string): Promise<Response> {
  const code = normalizeCode(rawCode);
  if (!code) return html(errorPage("Invalid code", "Enter the four digits shown on the Android phone."), 400);

  const identity = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limited = await env.CODE_ATTEMPTS.limit({ key: identity });
  if (!limited.success) return html(errorPage("Too many attempts", "Wait one minute, then try the code again."), 429);

  const room = env.PAIRING_ROOM.getByName(code);
  const result = await room.resolve();
  if (result.status === "ready") {
    return html(connectPage(result.targetUrl, result.targetType));
  }
  return html(errorPage("Code unavailable", "The code has expired or does not exist. Generate a new code on Android."), 404);
}

function normalizeCode(raw: string): string | null {
  const thaiDigits = "๐๑๒๓๔๕๖๗๘๙";
  const normalized = raw.trim()
    .replace(/[๐-๙]/g, (digit) => String(thaiDigits.indexOf(digit)))
    .replace(/[\s-]/g, "");
  return CODE_RE.test(normalized) ? normalized : null;
}

async function readJsonLimited(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_JSON_BYTES) throw new Error("Request body too large");
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new Error("Request body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function normalizeUploadUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.username || url.password) return null;
    if (!isPrivateIPv4(url.hostname) || url.port !== "8081" || url.pathname !== "/upload") return null;
    if (!url.searchParams.get("t")) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeDownloadUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.username || url.password) return null;
    if (!isPrivateIPv4(url.hostname) || url.port !== "8080") return null;
    if (url.pathname !== "/" && url.pathname !== "/download") return null;
    if (!url.searchParams.get("t")) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isDownloadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.port === "8080" && (url.pathname === "/" || url.pathname === "/download");
  } catch {
    return false;
  }
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function randomCode(): string {
  const values = new Uint16Array(1);
  do crypto.getRandomValues(values); while (values[0]! >= 60000);
  return String(values[0]! % 10000).padStart(4, "0");
}

function randomToken(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }),
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { status: response.status, headers });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: securityHeaders({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }),
  });
}

function securityHeaders(initial: HeadersInit = {}): Headers {
  const headers = new Headers(initial);
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return headers;
}

function homePage(message = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GoodFile Pair</title><style>${pageCss()}</style></head><body><main><div class="logo">GF</div><h1>GoodFile Transfer</h1><p>Enter the 4-digit code shown in GoodFile.</p>${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}<form method="get" action="/" novalidate><input name="code" inputmode="numeric" maxlength="12" autocomplete="one-time-code" placeholder="0000" aria-label="4-digit code" autofocus><button type="submit">Continue</button></form><small>Only pairing information uses the internet. Your file transfers directly over local Wi-Fi.</small></main></body></html>`;
}

function connectPage(targetUrl: string, targetType: "upload" | "download"): string {
  const target = escapeHtml(targetUrl);
  const download = targetType === "download";
  const title = download ? "File ready" : "Android found";
  const detail = download ? "Opening the download from your phone…" : "Opening the file receiver on your phone…";
  const action = download ? "Download file<br><span>ดาวน์โหลดไฟล์</span>" : "Open file receiver<br><span>เปิดหน้าส่งไฟล์</span>";
  const help = download
    ? "If it does not open, keep GoodFile open on the sending screen and connect both devices to the same Wi-Fi or hotspot."
    : "If it does not open, keep GoodFile on the Receive screen and connect both devices to the same Wi-Fi or hotspot.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="1;url=${target}"><title>${title} · GoodFile</title><style>${pageCss()}</style></head><body><main><div class="logo">✓</div><h1>${title}</h1><p>${detail}</p><a class="open" href="${target}">${action}</a><div class="message">${help}</div><small>This code can be tried again until it expires.</small></main></body></html>`;
}

function errorPage(title: string, message: string): string {
  return homePage(`${title}: ${message}`);
}

function pageCss(): string {
  return `:root{color-scheme:dark;font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--bg:#0A0F1E;--bg2:#111827;--bg3:#1A2235;--blue:#2979FF;--blue2:#1565C0;--text:#F0F4FF;--muted:rgba(240,244,255,.62);--line:rgba(130,177,255,.2)}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 18% 0,rgba(41,121,255,.24),transparent 38%),radial-gradient(circle at 88% 18%,rgba(24,119,242,.14),transparent 34%),var(--bg);color:var(--text)}main{width:min(440px,100%);padding:32px;border:1px solid var(--line);border-radius:26px;background:rgba(17,24,39,.9);text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.5),0 0 60px rgba(41,121,255,.09);backdrop-filter:blur(18px)}.logo{width:66px;height:66px;border-radius:19px;margin:0 auto 20px;display:grid;place-items:center;background:linear-gradient(145deg,var(--blue),var(--blue2));color:#fff;font-weight:900;box-shadow:0 10px 30px rgba(41,121,255,.35)}h1{margin:0 0 8px;font-size:32px;letter-spacing:-.8px}p,small{color:var(--muted);line-height:1.6}.message{margin:16px 0;padding:13px;border-radius:13px;background:rgba(41,121,255,.1);border:1px solid rgba(41,121,255,.3);color:#BFD5FF}form{display:flex;gap:11px;margin:24px 0}input{min-width:0;flex:1;padding:14px;border:1.5px solid rgba(130,177,255,.38);border-radius:14px;outline:none;background:rgba(10,15,30,.9);color:#fff;font:800 24px ui-monospace,"DM Mono",monospace;letter-spacing:8px;text-align:center;transition:border-color .18s,box-shadow .18s}input:focus{border-color:var(--blue);box-shadow:0 0 0 4px rgba(41,121,255,.14)}input::placeholder{color:rgba(240,244,255,.3)}button,.open{border:0;border-radius:14px;padding:15px 20px;background:linear-gradient(145deg,var(--blue),var(--blue2));color:#fff;font-weight:800;cursor:pointer;box-shadow:0 8px 24px rgba(41,121,255,.25);transition:transform .12s,filter .12s}button:hover,.open:hover{filter:brightness(1.08)}button:active,.open:active{transform:scale(.98)}.open{display:block;margin:22px 0;text-decoration:none;font-size:17px}.open span{font-size:13px;opacity:.8}@media(max-width:460px){main{padding:26px 20px}h1{font-size:27px}form{flex-direction:column}button{min-height:52px}}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export const testing = { normalizeUploadUrl, normalizeDownloadUrl, isPrivateIPv4, normalizeCode, randomCode };
