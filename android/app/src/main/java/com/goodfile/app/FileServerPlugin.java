package com.goodfile.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "FileServer")
public class FileServerPlugin extends Plugin {
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile ServerSocket sendServer;
    private volatile ServerSocket receiveServer;
    private volatile boolean sendRunning;
    private volatile boolean receiveRunning;
    private String fileUri;
    private String fileName;
    private String mimeType;
    private long fileSize = -1;
    private JSArray gallery;   // multi-image gallery mode (null = single-file send)
    private final java.util.Set<String> seenClients =
            java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());
    private volatile String token;  // access token for the active send/gallery server (null = open)
    private volatile String receiveToken; // protects the PC -> Android upload endpoint

    @PluginMethod
    public void getIP(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ip", getLocalIp());
        call.resolve(ret);
    }

    /**
     * Open the system document picker and return the ORIGINAL content:// uri
     * (plus name/size/mime) without copying the file anywhere. The send server
     * streams straight from this uri, so "QR ready" no longer depends on file size.
     */
    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, intent, "pickFileResult");
    }

    @ActivityCallback
    private void pickFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("cancelled");
            return;
        }
        JSArray files = new JSArray();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) files.put(describeUri(u));
            }
        } else if (data.getData() != null) {
            files.put(describeUri(data.getData()));
        }
        if (files.length() == 0) {
            call.reject("cancelled");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("files", files);
        call.resolve(ret);
    }

    // Take a read grant + read name/size/mime for one picked uri.
    private JSObject describeUri(Uri uri) {
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {
        }
        String name = "file";
        long size = 0;
        try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int si = c.getColumnIndex(OpenableColumns.SIZE);
                if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
                if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
            }
        } catch (Exception ignored) {
        }
        String mime = getContext().getContentResolver().getType(uri);
        if (mime == null || mime.isEmpty()) mime = guessMime(name);
        JSObject o = new JSObject();
        o.put("uri", uri.toString());
        o.put("name", name);
        o.put("size", size);
        o.put("mimeType", mime);
        return o;
    }

    @PluginMethod
    public void startServer(PluginCall call) {
        String uri = call.getString("uri", "");
        String name = call.getString("fileName", "goodfile_download");
        String mime = call.getString("mimeType", "application/octet-stream");
        int port = call.getInt("port", 8080);
        Double szD = call.getDouble("size", -1.0);
        if (uri.isEmpty()) {
            call.reject("Missing file uri");
            return;
        }
        stopSendServer();
        fileUri = uri;
        fileName = name;
        fileSize = (szD == null) ? -1L : szD.longValue();
        mimeType = mime == null || mime.isEmpty() ? guessMime(name) : mime;
        // The caller may hand us the token it already baked into the QR it painted.
        // Generating our own here would invalidate that QR and every scan would 401.
        token = callerToken(call);
        final String tok = token;
        pool.execute(() -> {
            try {
                sendServer = new ServerSocket(port);
                sendRunning = true;
                main.post(() -> TransferService.start(getContext(), fileName));
                String ip = getLocalIp();
                JSObject ret = new JSObject();
                // QR scanners open a browser-friendly landing page. The actual
                // file endpoint remains /download for backward compatibility.
                ret.put("url", "http://" + ip + ":" + port + "/?t=" + tok);
                ret.put("ip", ip);
                ret.put("token", tok);
                main.post(() -> call.resolve(ret));
                while (sendRunning) {
                    Socket socket = sendServer.accept();
                    pool.execute(() -> handleSendClient(socket));
                }
            } catch (Exception e) {
                if (sendRunning) {
                    main.post(() -> call.reject("Server error: " + e.getMessage()));
                }
            }
        });
    }

    /**
     * Serve MANY images as a browsable gallery (no zip): an index page at "/"
     * plus each image streamed inline from its content:// uri at "/f?i=N".
     * Lets the receiver (esp. iPhone Safari) long-press → Save to Photos per image.
     */
    @PluginMethod
    public void startGalleryServer(PluginCall call) {
        JSArray files = call.getArray("files");
        int port = call.getInt("port", 8080);
        if (files == null || files.length() == 0) {
            call.reject("No files");
            return;
        }
        stopSendServer();
        gallery = files;
        fileUri = null;
        token = callerToken(call);
        final String tok = token;
        pool.execute(() -> {
            try {
                sendServer = new ServerSocket(port);
                sendRunning = true;
                main.post(() -> TransferService.start(getContext(), fileName));
                String ip = getLocalIp();
                JSObject ret = new JSObject();
                ret.put("url", "http://" + ip + ":" + port + "/?t=" + tok);
                ret.put("ip", ip);
                ret.put("token", tok);
                main.post(() -> call.resolve(ret));
                while (sendRunning) {
                    Socket socket = sendServer.accept();
                    pool.execute(() -> handleSendClient(socket));
                }
            } catch (Exception e) {
                if (sendRunning) {
                    main.post(() -> call.reject("Gallery server error: " + e.getMessage()));
                }
            }
        });
    }

    @PluginMethod
    public void stopServer(PluginCall call) {
        stopSendServer();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void startReceiveServer(PluginCall call) {
        int port = call.getInt("port", 8081);
        stopReceiveServer();
        String requestedToken = call.getString("token", "");
        receiveToken = requestedToken == null || requestedToken.isEmpty() ? genReceiveToken() : requestedToken;
        final String activeReceiveToken = receiveToken;
        pool.execute(() -> {
            try {
                receiveServer = new ServerSocket(port);
                receiveRunning = true;
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("ip", getLocalIp());
                ret.put("url", "http://" + getLocalIp() + ":" + port + "/upload?t=" + activeReceiveToken);
                ret.put("token", activeReceiveToken);
                main.post(() -> call.resolve(ret));
                while (receiveRunning) {
                    Socket socket = receiveServer.accept();
                    pool.execute(() -> handleReceiveClient(socket));
                }
            } catch (Exception e) {
                if (receiveRunning) {
                    main.post(() -> call.reject("Receive server error: " + e.getMessage()));
                }
            }
        });
    }

    @PluginMethod
    public void stopReceiveServer(PluginCall call) {
        stopReceiveServer();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /**
     * Push a file straight to a device that advertised itself as a receiver.
     * This is the no-QR path: nothing is copied to disk and no browser is
     * involved -- we stream the original content:// uri into their /upload.
     */
    @PluginMethod
    public void uploadFile(PluginCall call) {
        String uri = call.getString("uri", "");
        String target = call.getString("url", "");
        String name = call.getString("fileName", "file");
        String mime = call.getString("mimeType", "application/octet-stream");
        Double szD = call.getDouble("size", -1.0);
        if (uri.isEmpty() || target.isEmpty()) {
            call.reject("Missing uri or url");
            return;
        }
        final long declared = (szD == null) ? -1L : szD.longValue();
        pool.execute(() -> {
            HttpURLConnection conn = null;
            try {
                long total = declared;
                if (total < 0) total = sizeOf(uri);

                String sep = target.indexOf('?') >= 0 ? "&" : "?";
                URL url = new URL(target + sep + "name=" + java.net.URLEncoder.encode(name, "UTF-8"));
                conn = (HttpURLConnection) url.openConnection();
                conn.setDoOutput(true);
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", mime);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(60000);
                if (total >= 0) conn.setFixedLengthStreamingMode(total);
                else conn.setChunkedStreamingMode(256 * 1024);

                InputStream in = openUriStream(uri);
                if (in == null) throw new IOException("Cannot open " + uri);

                long sent = 0;
                long lastTick = 0;
                try (BufferedInputStream bin = new BufferedInputStream(in);
                     OutputStream out = new BufferedOutputStream(conn.getOutputStream())) {
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = bin.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        sent += n;
                        // Throttle: a progress event per chunk would flood the bridge.
                        if (System.currentTimeMillis() - lastTick > 200) {
                            lastTick = System.currentTimeMillis();
                            JSObject p = new JSObject();
                            p.put("sent", sent);
                            p.put("total", total);
                            p.put("pct", total > 0 ? (int) (sent * 100 / total) : -1);
                            main.post(() -> notifyListeners("uploadProgress", p));
                        }
                    }
                    out.flush();
                }

                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) throw new IOException("HTTP " + code);

                final long sentF = sent;
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("sent", sentF);
                ret.put("status", code);
                main.post(() -> call.resolve(ret));
            } catch (Exception e) {
                String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                main.post(() -> call.reject("Upload failed: " + msg));
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private long sizeOf(String uriStr) {
        try {
            Uri u = Uri.parse(uriStr);
            if ("content".equalsIgnoreCase(u.getScheme())) {
                try (Cursor c = getContext().getContentResolver().query(u, null, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        int si = c.getColumnIndex(OpenableColumns.SIZE);
                        if (si >= 0 && !c.isNull(si)) return c.getLong(si);
                    }
                }
                return -1;
            }
            File f = "file".equalsIgnoreCase(u.getScheme()) ? new File(u.getPath()) : new File(uriStr);
            return f.exists() ? f.length() : -1;
        } catch (Exception e) {
            return -1;
        }
    }

    @PluginMethod
    public void readReceivedFile(PluginCall call) {
        String path = call.getString("path", "");
        String name = call.getString("name", "");
        if (path.isEmpty()) {
            call.reject("Missing file path");
            return;
        }
        pool.execute(() -> {
            try {
                Uri uri = Uri.parse(path);
                InputStream input;
                File file = null;
                if ("file".equalsIgnoreCase(uri.getScheme())) {
                    file = new File(uri.getPath());
                    input = new java.io.FileInputStream(file);
                } else if ("content".equalsIgnoreCase(uri.getScheme())) {
                    input = getContext().getContentResolver().openInputStream(uri);
                } else {
                    file = new File(path);
                    input = new java.io.FileInputStream(file);
                }
                if (input == null) throw new IOException("Cannot open file");
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (BufferedInputStream in = new BufferedInputStream(input)) {
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(buf)) != -1) bytes.write(buf, 0, n);
                }
                String fileName = name == null || name.isEmpty()
                        ? (file != null ? file.getName() : "received_file")
                        : name;
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                ret.put("fileName", fileName);
                ret.put("mimeType", guessMime(fileName));
                ret.put("size", file != null ? file.length() : bytes.size());
                ret.put("path", path);
                main.post(() -> call.resolve(ret));
            } catch (Exception e) {
                main.post(() -> call.reject("Read failed: " + e.getMessage()));
            }
        });
    }

    private void handleSendClient(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(30000);
            s.setSendBufferSize(256 * 1024);
            noteClient(s);
            HttpRequest req = readRequest(s.getInputStream());
            String base = req.path;
            int qm = base.indexOf('?');
            if (qm >= 0) base = base.substring(0, qm);
            // /api/ping is intentionally open (discovery probe, no file data leaks)
            if (base.startsWith("/api/ping")) {
                JSObject body = new JSObject();
                body.put("app", "goodfile");
                body.put("device", android.os.Build.MODEL);
                body.put("fileName", fileName);
                writeResponse(s.getOutputStream(), "200 OK", "application/json", body.toString().getBytes(StandardCharsets.UTF_8), null);
                return;
            }
            // Everything that exposes file data requires the access token from the QR/link.
            if (!tokenOk(req.path)) {
                // Someone scanned a QR/link that doesn't match this server -- almost
                // always a stale QR. Tell the sender, who is the only one who can fix
                // it; otherwise this failure is invisible to everyone but the receiver.
                JSObject ev = new JSObject();
                ev.put("path", base);
                ev.put("hadToken", !queryParam(req.path, "t").isEmpty());
                main.post(() -> notifyListeners("unauthorizedScan", ev));
                byte[] body = unauthorizedPage().getBytes(StandardCharsets.UTF_8);
                writeResponse(s.getOutputStream(), "401 Unauthorized", "text/html; charset=utf-8", body, "Cache-Control: no-store\r\n");
                return;
            }
            if (gallery != null && base.equals("/f")) {
                int idx = -1;
                try { idx = Integer.parseInt(queryParam(req.path, "i")); } catch (Exception ignored) {}
                streamGalleryFile(idx, s.getOutputStream());
                return;
            }
            if (gallery != null && (base.equals("/") || base.startsWith("/gallery"))) {
                byte[] page = galleryPage().getBytes(StandardCharsets.UTF_8);
                writeResponse(s.getOutputStream(), "200 OK", "text/html; charset=utf-8", page, "Cache-Control: no-store\r\n");
                return;
            }
            if (gallery == null && base.equals("/")) {
                byte[] page = downloadPage().getBytes(StandardCharsets.UTF_8);
                writeResponse(s.getOutputStream(), "200 OK", "text/html; charset=utf-8", page, "Cache-Control: no-store\r\n");
                return;
            }
            if (base.startsWith("/download")) {
                streamFile(s.getOutputStream(), req.range);
                return;
            }
            byte[] body = "goodfile".getBytes(StandardCharsets.UTF_8);
            writeResponse(s.getOutputStream(), "200 OK", "text/plain; charset=utf-8", body, null);
        } catch (Exception ignored) {
        }
    }

    private void handleReceiveClient(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(60000);
            s.setReceiveBufferSize(256 * 1024);
            HttpRequest req = readRequest(s.getInputStream());
            if ("OPTIONS".equals(req.method)) {
                writeResponse(s.getOutputStream(), "204 No Content", "text/plain", new byte[0],
                        "Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n"
                                + "Access-Control-Allow-Headers: Content-Type\r\n");
                return;
            }
            if (req.path.startsWith("/api/ping")) {
                JSObject body = new JSObject();
                body.put("app", "goodfile");
                body.put("device", android.os.Build.MODEL);
                writeResponse(s.getOutputStream(), "200 OK", "application/json", body.toString().getBytes(StandardCharsets.UTF_8), null);
                return;
            }
            if (!receiveTokenOk(req.path)) {
                writeResponse(s.getOutputStream(), "401 Unauthorized", "text/plain; charset=utf-8",
                        "Invalid or expired upload link".getBytes(StandardCharsets.UTF_8),
                        "Cache-Control: no-store\r\n");
                return;
            }
            if ("GET".equals(req.method) && (req.path.equals("/") || req.path.startsWith("/upload"))) {
                byte[] body = uploadPage().getBytes(StandardCharsets.UTF_8);
                writeResponse(s.getOutputStream(), "200 OK", "text/html; charset=utf-8", body,
                        "Cache-Control: no-store\r\n");
                return;
            }
            if (!"POST".equals(req.method) || !req.path.startsWith("/upload")) {
                writeResponse(s.getOutputStream(), "404 Not Found", "text/plain", "Not found".getBytes(StandardCharsets.UTF_8), null);
                return;
            }
            String name = safeName(queryParam(req.path, "name"));
            if (name.isEmpty()) name = "goodfile_" + System.currentTimeMillis();
            File out = new File(getContext().getCacheDir(), name);
            try (FileOutputStream fos = new FileOutputStream(out)) {
                if (req.bodyPrefix.length > 0) fos.write(req.bodyPrefix);
                copy(req.input, fos, req.contentLength - req.bodyPrefix.length);
            }
            JSObject event = new JSObject();
            event.put("fileName", name);
            event.put("name", name);
            event.put("size", out.length());
            event.put("path", out.getAbsolutePath());
            event.put("uri", Uri.fromFile(out).toString());
            main.post(() -> notifyListeners("fileReceived", event));
            JSObject body = new JSObject();
            body.put("ok", true);
            body.put("fileName", name);
            body.put("size", out.length());
            body.put("path", out.getAbsolutePath());
            writeResponse(s.getOutputStream(), "200 OK", "application/json", body.toString().getBytes(StandardCharsets.UTF_8), null);
        } catch (Exception ignored) {
        }
    }

    private static final String PLAY_URL =
            "https://play.google.com/store/apps/details?id=com.goodfile.app&pcampaignid=web_share";

    // Growth loop: every receiver opens one of our served pages without having the app.
    // This banner turns each transfer into a free install prompt to a warm prospect.
    private String referralBanner(boolean en) {
        String title = en ? "Send files free — no app needed to receive" : "ส่งไฟล์ฟรี ไม่ต้องลงแอปฝั่งรับ";
        String sub   = en ? "Open with goodfile — tap to install"        : "เปิดด้วย goodfile — แตะติดตั้ง";
        String cta   = en ? "Get app"                                     : "โหลดแอป";
        return "<a href='" + PLAY_URL + "' style='display:flex;align-items:center;gap:11px;text-decoration:none;"
                + "max-width:460px;margin:16px auto 0;background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:13px 15px'>"
                + "<div style='width:40px;height:40px;border-radius:11px;background:var(--green);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px'>🚀</div>"
                + "<div style='flex:1;min-width:0'>"
                + "<div style='font-size:14px;font-weight:600;color:var(--label)'>" + title + "</div>"
                + "<div style='font-size:12px;color:var(--label2);margin-top:1px'>" + sub + "</div></div>"
                + "<div style='flex-shrink:0;background:var(--green);color:#fff;font-size:13px;font-weight:600;padding:8px 13px;border-radius:11px'>" + cta + "</div></a>";
    }

    /**
     * A bare "Unauthorized" string told the receiver nothing and left them stuck.
     * The cause is nearly always a QR from an earlier transfer, so say that, in
     * both languages, and tell them exactly what to ask for.
     */
    private String unauthorizedPage() {
        return "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>"
                + "<meta name='theme-color' content='#F2F2F7' media='(prefers-color-scheme: light)'>"
                + "<meta name='theme-color' content='#000000' media='(prefers-color-scheme: dark)'>"
                + "<title>goodfile</title><style>"
                + ":root{--bg:#F2F2F7;--card:#FFFFFF;--label:#1C1C1E;--label2:rgba(60,60,67,.6);--sep:rgba(60,60,67,.16);--orange:#FF9500}"
                + "@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1C1C1E;--label:#FFF;--label2:rgba(235,235,245,.6);--sep:rgba(120,120,128,.32);--orange:#FF9F0A}}"
                + "*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}"
                + "body{background:var(--bg);color:var(--label);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;-webkit-font-smoothing:antialiased;display:flex;align-items:center;justify-content:center;padding:24px}"
                + ".card{background:var(--card);border:1px solid var(--sep);border-radius:22px;padding:30px 24px;max-width:400px;width:100%;text-align:center}"
                + ".ic{width:62px;height:62px;border-radius:18px;background:var(--orange);display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto 18px}"
                + "h1{font-size:19px;font-weight:650;letter-spacing:-.3px;margin-bottom:8px}"
                + ".sub{font-size:14px;color:var(--label2);line-height:1.55}"
                + ".en{font-size:13px;color:var(--label2);line-height:1.5;margin-top:14px;padding-top:14px;border-top:1px solid var(--sep)}"
                + ".steps{text-align:left;font-size:13.5px;color:var(--label2);line-height:1.9;margin-top:16px;padding-top:16px;border-top:1px solid var(--sep)}"
                + ".steps b{color:var(--label);font-weight:600}"
                + "</style></head><body><div class='card'>"
                + "<div class='ic'>⏳</div>"
                + "<h1>ลิงก์นี้ใช้ไม่ได้แล้ว</h1>"
                + "<div class='sub'>QR นี้เป็นของการส่งครั้งก่อน ฝั่งส่งได้เริ่มรายการใหม่ไปแล้ว</div>"
                + "<div class='steps'>ทำอย่างไรต่อ:<br>"
                + "<b>1.</b> ให้ฝั่งส่งเลือกไฟล์อีกครั้ง<br>"
                + "<b>2.</b> สแกน QR อันใหม่ที่ขึ้นมา<br>"
                + "<b>3.</b> อย่าใช้ QR ที่ถ่ายเก็บไว้ หรือแท็บเดิมที่ค้างอยู่</div>"
                + "<div class='en'><b>This link has expired.</b><br>"
                + "The QR you scanned belongs to an earlier transfer. Ask the sender to pick the file again and scan the new QR — a screenshotted or reloaded link won't work.</div>"
                + "</div></body></html>";
    }

    /**
     * Landing page for ordinary QR scanners on Windows, macOS, and Linux.
     * Receiving only requires a browser; GoodFile is not installed on the PC.
     */
    private String downloadPage() {
        String safeFileName = escapeHtml(fileName == null || fileName.isEmpty() ? "goodfile_download" : fileName);
        String safeSize = fileSize >= 0 ? humanSize(fileSize) : "Ready to download";
        String safeToken = token == null ? "" : token.replaceAll("[^A-Za-z0-9_-]", "");
        return "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>"
                + "<meta name='theme-color' content='#0A0F1E'><title>Receive with goodfile</title><style>"
                + ":root{color-scheme:dark;--bg:#0A0F1E;--card:#111827;--line:rgba(130,177,255,.20);--text:#F0F4FF;--muted:rgba(240,244,255,.62);--blue:#2979FF;--blue2:#1565C0}"
                + "*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 18% 0,rgba(41,121,255,.24),transparent 38%),radial-gradient(circle at 88% 18%,rgba(24,119,242,.14),transparent 34%),var(--bg);color:var(--text);font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:grid;place-items:center;padding:24px}"
                + ".card{width:min(440px,100%);background:rgba(17,24,39,.94);border:1px solid var(--line);border-radius:26px;padding:30px;box-shadow:0 24px 70px rgba(0,0,0,.5),0 0 60px rgba(41,121,255,.09);text-align:center}"
                + ".mark{width:70px;height:70px;margin:0 auto 18px;border-radius:21px;background:linear-gradient(145deg,var(--blue),var(--blue2));display:grid;place-items:center;font-size:32px;box-shadow:0 12px 28px rgba(41,121,255,.35)}"
                + ".brand{font-size:13px;font-weight:800;letter-spacing:1.7px;color:#82B1FF;text-transform:uppercase}h1{font-size:25px;margin:8px 0 10px}.name{font-size:16px;font-weight:650;word-break:break-word}.size{font-size:13px;color:var(--muted);margin-top:5px}"
                + ".download{display:block;margin-top:24px;padding:15px 18px;border-radius:15px;background:linear-gradient(145deg,var(--blue),var(--blue2));color:#fff;text-decoration:none;font-size:17px;font-weight:800;box-shadow:0 8px 24px rgba(41,121,255,.25)}.download:hover{filter:brightness(1.07)}"
                + ".note{font-size:13px;color:var(--muted);line-height:1.55;margin:18px 0 0}.ok{display:flex;gap:7px;justify-content:center;flex-wrap:wrap;margin-top:18px}.pill{border:1px solid var(--line);border-radius:999px;padding:6px 10px;font-size:11px;color:var(--muted)}"
                + "</style></head><body><main class='card'>"
                + "<div class='mark'>&darr;</div><div class='brand'>goodfile</div><h1>File ready to download</h1>"
                + "<div class='name'>" + safeFileName + "</div><div class='size'>" + safeSize + "</div>"
                + "<a class='download' href='/download?t=" + safeToken + "' download>Download file</a>"
                + "<p class='note'>No GoodFile installation is needed on this device.<br>Keep the sending phone on this screen until the download finishes.</p>"
                + "<div class='ok'><span class='pill'>Same Wi-Fi</span><span class='pill'>Direct transfer</span><span class='pill'>No cloud</span></div>"
                + "</main></body></html>";
    }

    private String uploadPage() {
        return "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover'>"
                + "<meta name='theme-color' content='#F2F2F7' media='(prefers-color-scheme: light)'>"
                + "<meta name='theme-color' content='#000000' media='(prefers-color-scheme: dark)'>"
                + "<title>goodfile</title>"
                + "<style>"
                + ":root{--bg:#F2F2F7;--card:#FFFFFF;--label:#1C1C1E;--label2:rgba(60,60,67,.6);--sep:rgba(60,60,67,.16);--blue:#007AFF;--green:#34C759;--red:#FF3B30;--track:rgba(120,120,128,.2)}"
                + "@media(prefers-color-scheme:dark){:root{--bg:#000000;--card:#1C1C1E;--label:#FFFFFF;--label2:rgba(235,235,245,.6);--sep:rgba(120,120,128,.32);--blue:#0A84FF;--green:#30D158;--red:#FF453A;--track:rgba(120,120,128,.3)}}"
                + "*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}html,body{height:100%}"
                + "body{background:var(--bg);color:var(--label);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro Display',system-ui,sans-serif;-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;padding:calc(env(safe-area-inset-top) + 8px) 16px calc(env(safe-area-inset-bottom) + 18px)}"
                + ".nav{text-align:center;padding:12px 0 4px}.nav .ttl{font-size:17px;font-weight:700;letter-spacing:-.2px}.nav .ttl .g{color:var(--green)}.nav .sub{font-size:13px;color:var(--label2);margin-top:3px}"
                + ".wrap{flex:1;display:flex;flex-direction:column;justify-content:center;gap:14px;max-width:460px;width:100%;margin:0 auto}"
                + ".drop{background:var(--card);border:1px solid var(--sep);border-radius:22px;padding:34px 20px;display:flex;flex-direction:column;align-items:center;gap:14px;cursor:pointer;transition:transform .15s ease;box-shadow:0 1px 3px rgba(0,0,0,.05)}.drop:active{transform:scale(.98)}"
                + ".glyph{width:66px;height:66px;border-radius:19px;background:linear-gradient(180deg,#0A84FF,#0066FF);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 20px rgba(0,90,255,.32)}.glyph svg{width:30px;height:30px}"
                + ".drop .big{font-size:19px;font-weight:600;letter-spacing:-.3px}.drop .small{font-size:13px;color:var(--label2);text-align:center;line-height:1.4}"
                + "input[type=file]{display:none}"
                + ".cell{display:none;background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden}.cell.on{display:block}.cellrow{display:flex;align-items:center;gap:12px;padding:13px 15px}"
                + ".fic{width:38px;height:38px;border-radius:10px;background:var(--blue);display:flex;align-items:center;justify-content:center;flex-shrink:0}.fic svg{width:20px;height:20px}"
                + ".cmeta{flex:1;min-width:0}.cname{font-size:16px;font-weight:500;letter-spacing:-.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.csize{font-size:13px;color:var(--label2);margin-top:1px}"
                + ".prog{display:none;flex-direction:column;gap:9px;padding:2px 6px}.prog.on{display:flex}.track{height:6px;border-radius:3px;background:var(--track);overflow:hidden}.bar{height:100%;width:0;border-radius:3px;background:var(--blue);transition:width .25s ease}"
                + ".prow{display:flex;justify-content:space-between;font-size:13px;color:var(--label2)}.pct{font-variant-numeric:tabular-nums;color:var(--blue);font-weight:600}"
                + ".btn{width:100%;border:0;border-radius:14px;background:var(--blue);color:#fff;font-size:17px;font-weight:600;letter-spacing:-.3px;padding:15px;font-family:inherit;cursor:pointer;transition:opacity .15s,transform .1s}.btn:active{transform:scale(.985);opacity:.85}.btn:disabled{opacity:.4}.btn.sec{background:transparent;color:var(--blue)}"
                + ".status{text-align:center;font-size:13px;color:var(--label2);min-height:18px;line-height:1.4}.status.ok{color:var(--green);font-weight:500}.status.err{color:var(--red);font-weight:500}"
                + ".foot{display:flex;gap:7px;justify-content:center;flex-wrap:wrap;padding-top:4px}.tag{font-size:12px;color:var(--label2);padding:5px 11px;border-radius:100px;background:var(--card);border:1px solid var(--sep)}"
                + "</style></head><body>"
                + "<div class='nav'><div class='ttl'>good<span class='g'>file</span></div><div class='sub'>ส่งไฟล์เข้าเครื่องนี้</div></div>"
                + "<div class='wrap'>"
                + "<label class='drop' for='f'><div class='glyph'><svg viewBox='0 0 24 24' fill='none'><path d='M12 15V4' stroke='#fff' stroke-width='2.2' stroke-linecap='round'/><path d='M7.5 8.5L12 4l4.5 4.5' stroke='#fff' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/><path d='M5 14v3.5A2.5 2.5 0 007.5 20h9a2.5 2.5 0 002.5-2.5V14' stroke='#fff' stroke-width='2.2' stroke-linecap='round'/></svg></div>"
                + "<div class='big' id='picklbl'>เลือกไฟล์</div><div class='small' id='hint'>แตะเพื่อเลือกไฟล์</div></label>"
                + "<input id='f' type='file'>"
                + "<div class='cell' id='cell'><div class='cellrow'><div class='fic'><svg viewBox='0 0 24 24' fill='none'><path d='M7 2.5h6.5L18 7v13a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 016 20V4A1.5 1.5 0 017 2.5z' stroke='#fff' stroke-width='1.7' stroke-linejoin='round'/><path d='M13 2.5V7h5' stroke='#fff' stroke-width='1.7' stroke-linejoin='round'/></svg></div>"
                + "<div class='cmeta'><div class='cname' id='name'>No file</div><div class='csize' id='size'>-</div></div></div></div>"
                + "<div class='prog' id='prog'><div class='track'><div class='bar' id='bar'></div></div><div class='prow'><span id='pstat'>กำลังเตรียม</span><span class='pct' id='pct'>0%</span></div></div>"
                + "<button class='btn' id='send' disabled>ส่งไฟล์</button>"
                + "<button class='btn sec' id='again' style='display:none' type='button'>ส่งไฟล์อื่น</button>"
                + "<div class='status' id='status'>เชื่อมต่อผ่าน Wi-Fi เดียวกัน</div>"
                + "<div class='foot'><span class='tag'>Wi-Fi ภายใน</span><span class='tag'>ไม่ผ่านคลาวด์</span><span class='tag'>ปลอดภัย</span></div>"
                + referralBanner(false)
                + "</div><script>"
                + "var f=document.getElementById('f'),sb=document.getElementById('send'),ag=document.getElementById('again'),cl=document.getElementById('cell'),nm=document.getElementById('name'),sz=document.getElementById('size'),st=document.getElementById('status'),pb=document.getElementById('bar'),pc=document.getElementById('pct'),ps=document.getElementById('pstat'),pr=document.getElementById('prog'),pl=document.getElementById('picklbl'),ht=document.getElementById('hint'),tk=new URLSearchParams(location.search).get('t')||'';"
                + "function fmt(n){if(!n)return'0 B';var u=['B','KB','MB','GB'],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return(n>=10||i==0?Math.round(n):n.toFixed(1))+' '+u[i]}"
                + "f.onchange=function(){var file=f.files[0];sb.disabled=!file;pb.style.width='0%';pc.textContent='0%';pr.className='prog';st.className='status';ag.style.display='none';sb.style.display='block';if(file){cl.className='cell on';nm.textContent=file.name;sz.textContent=fmt(file.size);pl.textContent='พร้อมส่ง';ht.textContent='แตะปุ่มส่งไฟล์ด้านล่าง';st.textContent='พร้อมส่ง'}else{cl.className='cell';st.textContent='เชื่อมต่อผ่าน Wi-Fi เดียวกัน';pl.textContent='เลือกไฟล์';ht.textContent='แตะเพื่อเลือกไฟล์'}};"
                + "ag.onclick=function(){f.value='';cl.className='cell';pr.className='prog';ag.style.display='none';sb.style.display='block';sb.disabled=true;pl.textContent='เลือกไฟล์';ht.textContent='แตะเพื่อเลือกไฟล์';st.className='status';st.textContent='เชื่อมต่อผ่าน Wi-Fi เดียวกัน';pb.style.width='0%';pc.textContent='0%'};"
                + "sb.onclick=function(){var file=f.files[0];if(!file)return;sb.disabled=true;pr.className='prog on';st.className='status';st.textContent='กำลังส่ง';ps.textContent='กำลังเชื่อมต่อ';var x=new XMLHttpRequest();x.open('POST','/upload?name='+encodeURIComponent(file.name)+'&t='+encodeURIComponent(tk));x.setRequestHeader('Content-Type',file.type||'application/octet-stream');x.upload.onprogress=function(e){if(e.lengthComputable){var p=Math.round(e.loaded*100/e.total);pb.style.width=p+'%';pc.textContent=p+'%';ps.textContent=fmt(e.loaded)+' / '+fmt(e.total)}};x.onload=function(){pb.style.width='100%';pc.textContent='100%';if(x.status>=200&&x.status<300){st.className='status ok';st.textContent='ส่งสำเร็จ ปิดหน้านี้ได้เลย';ps.textContent='เสร็จ';sb.style.display='none';ag.style.display='block';pl.textContent='ส่งแล้ว'}else{sb.disabled=false;st.className='status err';st.textContent='ส่งไม่สำเร็จ: HTTP '+x.status;ps.textContent='ผิดพลาด'}};x.onerror=function(){sb.disabled=false;st.className='status err';st.textContent='เชื่อมต่อเครื่องรับไม่ได้';ps.textContent='เชื่อมต่อผิดพลาด'};x.send(file)};"
                + "(function(){var D={'ส่งไฟล์ฟรี ไม่ต้องลงแอปฝั่งรับ':'Send files free — no app needed to receive','เปิดด้วย goodfile — แตะติดตั้ง':'Open with goodfile — tap to install','โหลดแอป':'Get app','ส่งไฟล์เข้าเครื่องนี้':'Send a file to this device','แตะเพื่อเลือกไฟล์':'Tap to choose a file','เลือกไฟล์':'Choose a file','แตะปุ่มส่งไฟล์ด้านล่าง':'Tap Send below','พร้อมส่ง':'Ready to send','เชื่อมต่อผ่าน Wi-Fi เดียวกัน':'Connected over the same Wi-Fi','ส่งไฟล์อื่น':'Send another','ส่งไฟล์':'Send file','กำลังเตรียม':'Preparing','Wi-Fi ภายใน':'Local Wi-Fi','ไม่ผ่านคลาวด์':'No cloud','ปลอดภัย':'Private','กำลังส่ง':'Sending','กำลังเชื่อมต่อ':'Connecting','ส่งสำเร็จ ปิดหน้านี้ได้เลย':'Sent - you can close this page','เสร็จ':'Done','ส่งแล้ว':'Sent','ส่งไม่สำเร็จ: HTTP ':'Failed: HTTP ','เชื่อมต่อเครื่องรับไม่ได้':'Cannot reach the receiver','เชื่อมต่อผิดพลาด':'Connection error','ผิดพลาด':'Error'};"
                + "var lang='en';try{var sv=localStorage.getItem('gf_lang');if(sv==='en'||sv==='th')lang=sv;}catch(e){}"
                + "var keys=Object.keys(D).sort(function(a,b){return b.length-a.length;});var re=new RegExp(keys.join('|'),'g');"
                + "function tr(t){if(lang==='th'||!t||!/[฀-๿]/.test(t))return t;return t.replace(re,function(m){return D[m]||m;});}"
                + "function ap(n){if(n.__o===undefined)n.__o=n.nodeValue;var v=lang==='th'?n.__o:tr(n.__o);n.__t=v;if(n.nodeValue!==v)n.nodeValue=v;}"
                + "function ob(n){if(n.nodeValue===n.__t)return;n.__o=n.nodeValue;ap(n);}"
                + "function wk(n,f){if(!n)return;if(n.nodeType===3){f(n);return;}if(n.nodeType===1){var T=n.tagName;if(T==='SCRIPT'||T==='STYLE')return;for(var c=n.firstChild;c;c=c.nextSibling)wk(c,f);}}"
                + "function run(){wk(document.body,ap);new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];if(m.type==='characterData')ob(m.target);else for(var j=0;j<m.addedNodes.length;j++)wk(m.addedNodes[j],ap);}}).observe(document.body,{childList:true,subtree:true,characterData:true});"
                + "var b=document.createElement('button');b.type='button';b.textContent=lang==='th'?'EN':'ไทย';b.style.cssText='position:fixed;top:calc(env(safe-area-inset-top) + 10px);right:12px;z-index:99;background:var(--card);color:var(--label);border:1px solid var(--sep);border-radius:100px;padding:6px 12px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer';"
                + "b.onclick=function(){lang=lang==='th'?'en':'th';try{localStorage.setItem('gf_lang',lang);}catch(e){}b.textContent=lang==='th'?'EN':'ไทย';document.documentElement.setAttribute('lang',lang);wk(document.body,ap);};document.body.appendChild(b);}"
                + "document.documentElement.setAttribute('lang',lang);if(document.body)run();else document.addEventListener('DOMContentLoaded',run);})();"
                + "</script></body></html>";
    }

    private void streamFile(OutputStream raw, String rangeHeader) throws IOException {
        long length = fileSize;
        InputStream input;
        Uri uri = Uri.parse(fileUri);
        if ("file".equalsIgnoreCase(uri.getScheme())) {
            File f = new File(uri.getPath()); length = f.length(); input = new java.io.FileInputStream(f);
        } else if (fileUri.startsWith("/")) {
            File f = new File(fileUri); length = f.length(); input = new java.io.FileInputStream(f);
        } else {
            input = getContext().getContentResolver().openInputStream(uri);
        }
        if (input == null) throw new IOException("Cannot open file");
        long start = 0;
        if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
            try { start = Long.parseLong(rangeHeader.substring(6).split("-")[0]); } catch (Exception ignored) {}
        }
        if (length >= 0 && start >= length) {
            raw.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            raw.flush(); input.close(); return;
        }
        long skipped = 0;
        while (skipped < start) {
            long n = input.skip(start - skipped);
            if (n <= 0) { if (input.read() == -1) break; n = 1; }
            skipped += n;
        }
        final long totalLength = length;
        final long startOffset = start;
        long remaining = length >= 0 ? length - start : -1;
        String headers = "HTTP/1.1 " + (start > 0 ? "206 Partial Content" : "200 OK") + "\r\n"
                + "Content-Type: " + mimeType + "\r\n"
                + "Content-Disposition: attachment; filename=\"" + fileName.replace("\"", "") + "\"\r\n"
                + "Accept-Ranges: bytes\r\n"
                + (start > 0 && length >= 0 ? "Content-Range: bytes " + start + "-" + (length - 1) + "/" + length + "\r\n" : "")
                + (remaining >= 0 ? "Content-Length: " + remaining + "\r\n" : "")
                + "Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n";
        raw.write(headers.getBytes(StandardCharsets.UTF_8));
        long sent = start;
        long startedAt = System.currentTimeMillis();
        long lastEventAt = 0;
        try (BufferedInputStream in = new BufferedInputStream(input); BufferedOutputStream out = new BufferedOutputStream(raw)) {
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n); sent += n;
                long now = System.currentTimeMillis();
                if (now - lastEventAt >= 250 || (totalLength > 0 && sent >= totalLength)) {
                    lastEventAt = now;
                    long elapsed = Math.max(1, now - startedAt);
                    long speed = Math.max(0, sent - startOffset) * 1000L / elapsed;
                    JSObject progress = new JSObject();
                    progress.put("bytes", sent); progress.put("total", totalLength);
                    progress.put("progress", totalLength > 0 ? Math.min(100, sent * 100L / totalLength) : -1);
                    progress.put("speed", speed);
                    progress.put("eta", totalLength > 0 && speed > 0 ? Math.max(0, (totalLength - sent) / speed) : -1);
                    main.post(() -> notifyListeners("transferProgress", progress));
                }
            }
            out.flush();
        }
        final long sentF = sent;
        JSObject ev = new JSObject();
        ev.put("fileName", fileName); ev.put("size", sentF); ev.put("mimeType", mimeType);
        main.post(() -> notifyListeners("fileDownloaded", ev));
    }
    private InputStream openUriStream(String uriStr) {
        try {
            if (uriStr == null || uriStr.isEmpty()) return null;
            Uri u = Uri.parse(uriStr);
            if ("file".equalsIgnoreCase(u.getScheme())) return new java.io.FileInputStream(new File(u.getPath()));
            if (uriStr.startsWith("/")) return new java.io.FileInputStream(new File(uriStr));
            return getContext().getContentResolver().openInputStream(u);
        } catch (Exception e) {
            return null;
        }
    }

    private void streamGalleryFile(int idx, OutputStream raw) throws IOException {
        org.json.JSONObject o = null;
        if (gallery != null && idx >= 0 && idx < gallery.length()) {
            try { o = gallery.getJSONObject(idx); } catch (Exception ignored) {}
        }
        if (o == null) {
            writeResponse(raw, "404 Not Found", "text/plain", "Not found".getBytes(StandardCharsets.UTF_8), null);
            return;
        }
        String uriStr = o.optString("uri", "");
        String mime = o.optString("mimeType", "application/octet-stream");
        long size = o.optLong("size", -1);
        InputStream input = openUriStream(uriStr);
        if (input == null) {
            writeResponse(raw, "404 Not Found", "text/plain", "Not found".getBytes(StandardCharsets.UTF_8), null);
            return;
        }
        String headers = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: " + mime + "\r\n"
                + (size >= 0 ? "Content-Length: " + size + "\r\n" : "")
                + "Access-Control-Allow-Origin: *\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        raw.write(headers.getBytes(StandardCharsets.UTF_8));
        try (BufferedInputStream in = new BufferedInputStream(input); BufferedOutputStream out = new BufferedOutputStream(raw)) {
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            out.flush();
        }
    }

    private String galleryPage() {
        StringBuilder cells = new StringBuilder();
        int n = gallery != null ? gallery.length() : 0;
        for (int i = 0; i < n; i++) {
            String name = "image";
            try { name = gallery.getJSONObject(i).optString("name", "image"); } catch (Exception ignored) {}
            String safe = name.replace("'", "").replace("\"", "").replace("<", "").replace(">", "");
            String tq = (token == null || token.isEmpty()) ? "" : "&t=" + token;
            cells.append("<div class='cell'><a class='imgwrap' href='/f?i=").append(i).append(tq).append("'>")
                 .append("<img loading='lazy' src='/f?i=").append(i).append(tq).append("' alt='").append(safe).append("'></a>")
                 .append("<div class='cap'><span class='nm'>").append(safe).append("</span>")
                 .append("<a class='dl' href='/f?i=").append(i).append(tq).append("' download='").append(safe).append("'>↓</a></div></div>");
        }
        return "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>"
                + "<meta name='theme-color' content='#F2F2F7' media='(prefers-color-scheme: light)'>"
                + "<meta name='theme-color' content='#000000' media='(prefers-color-scheme: dark)'>"
                + "<title>goodfile</title><style>"
                + ":root{--bg:#F2F2F7;--card:#FFFFFF;--label:#1C1C1E;--label2:rgba(60,60,67,.6);--sep:rgba(60,60,67,.16);--blue:#007AFF;--green:#34C759}"
                + "@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1C1C1E;--label:#FFF;--label2:rgba(235,235,245,.6);--sep:rgba(120,120,128,.32);--blue:#0A84FF;--green:#30D158}}"
                + "*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}"
                + "body{background:var(--bg);color:var(--label);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:calc(env(safe-area-inset-top) + 10px) 14px calc(env(safe-area-inset-bottom) + 18px)}"
                + ".nav{text-align:center;padding:6px 0 12px}.nav .ttl{font-size:17px;font-weight:700}.nav .ttl .g{color:var(--green)}.nav .sub{font-size:13px;color:var(--label2);margin-top:3px}"
                + ".hint{text-align:center;font-size:12px;color:var(--label2);background:var(--card);border:1px solid var(--sep);border-radius:12px;padding:9px 12px;margin:0 auto 14px;max-width:460px;line-height:1.5}"
                + ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;max-width:720px;margin:0 auto}"
                + ".cell{background:var(--card);border:1px solid var(--sep);border-radius:16px;overflow:hidden}"
                + ".imgwrap{display:block;aspect-ratio:1;background:var(--bg)}.imgwrap img{width:100%;height:100%;object-fit:cover;display:block}"
                + ".cap{display:flex;align-items:center;gap:8px;padding:8px 10px}.nm{flex:1;min-width:0;font-size:12px;color:var(--label2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
                + ".dl{flex-shrink:0;width:30px;height:30px;border-radius:8px;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;text-decoration:none}"
                + "</style></head><body>"
                + "<div class='nav'><div class='ttl'>good<span class='g'>file</span></div><div class='sub'>" + n + " photos</div></div>"
                + "<div class='hint'>💡 Tap a photo to open · long-press to save to your gallery</div>"
                + "<div class='grid'>" + cells + "</div>"
                + referralBanner(true)
                + "</body></html>";
    }

    private HttpRequest readRequest(InputStream raw) throws IOException {
        ByteArrayOutputStream header = new ByteArrayOutputStream();
        int matched = 0, b;
        byte[] end = new byte[]{'\r', '\n', '\r', '\n'};
        while ((b = raw.read()) != -1) {
            header.write(b);
            matched = b == end[matched] ? matched + 1 : (b == end[0] ? 1 : 0);
            if (matched == 4) break;
        }
        String h = header.toString("UTF-8");
        String[] lines = h.split("\r\n");
        String[] first = lines.length > 0 ? lines[0].split(" ") : new String[]{"GET", "/"};
        long len = 0;
        String range = null;
        for (String line : lines) {
            int idx = line.indexOf(':');
            if (idx <= 0) continue;
            String key = line.substring(0, idx).trim().toLowerCase(Locale.US);
            String value = line.substring(idx + 1).trim();
            if ("content-length".equals(key)) {
                try { len = Long.parseLong(value); } catch (Exception ignored) {}
            } else if ("range".equals(key)) {
                range = value;
            }
        }
        HttpRequest req = new HttpRequest();
        req.method = first.length > 0 ? first[0] : "GET";
        req.path = first.length > 1 ? first[1] : "/";
        req.contentLength = len; req.range = range; req.input = raw; req.bodyPrefix = new byte[0];
        return req;
    }
    private void writeResponse(OutputStream out, String status, String type, byte[] body, String extra) throws IOException {
        String headers = "HTTP/1.1 " + status + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + (extra == null ? "" : extra)
                + "Connection: close\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    /**
     * A request arriving from another device is the only proof that the two
     * phones can actually reach each other. Pinging our own server from our own
     * device proves nothing, so this is what the UI should trust.
     */
    private void noteClient(Socket s) {
        try {
            InetAddress addr = s.getInetAddress();
            if (addr == null) return;
            String ip = addr.getHostAddress();
            if (ip == null || ip.isEmpty() || addr.isLoopbackAddress()) return;
            if (!seenClients.add(ip)) return;   // one event per device, not per request
            JSObject ev = new JSObject();
            ev.put("ip", ip);
            ev.put("count", seenClients.size());
            main.post(() -> notifyListeners("clientConnected", ev));
        } catch (Exception ignored) {
        }
    }

    private void stopSendServer() {
        sendRunning = false;
        gallery = null;
        token = null;
        seenClients.clear();
        try { if (sendServer != null) sendServer.close(); } catch (Exception ignored) {}
        sendServer = null;
        main.post(() -> TransferService.stop(getContext()));
    }

    // Use the token the JS side already published in the QR/mDNS record when it
    // supplies one; only mint a fresh one when it doesn't.
    private String callerToken(PluginCall call) {
        String t = call.getString("token", "");
        if (t != null) t = t.trim();
        return (t == null || t.isEmpty()) ? genToken() : t;
    }

    private String genToken() {
        byte[] b = new byte[4];
        new java.security.SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    // null/empty token = open server (back-compat); otherwise the "t" query param must match.
    private boolean tokenOk(String path) {
        String tk = token;
        if (tk == null || tk.isEmpty()) return true;
        return tk.equals(queryParam(path, "t"));
    }

    private boolean receiveTokenOk(String path) {
        String tk = receiveToken;
        return tk != null && !tk.isEmpty() && tk.equals(queryParam(path, "t"));
    }

    private String genReceiveToken() {
        byte[] bytes = new byte[16];
        new java.security.SecureRandom().nextBytes(bytes);
        StringBuilder value = new StringBuilder();
        for (byte item : bytes) value.append(String.format("%02x", item));
        return value.toString();
    }

    private void stopReceiveServer() {
        receiveRunning = false;
        try { if (receiveServer != null) receiveServer.close(); } catch (Exception ignored) {}
        receiveServer = null;
        receiveToken = null;
    }

    // Local file transfer only works over Wi-Fi, so we must return the Wi-Fi
    // interface's address specifically -- not whichever interface the OS
    // happens to enumerate first (that could be mobile data / rmnet, which
    // produces a QR/link the other device on the same Wi-Fi can never reach).
    private String getLocalIp() {
        String wifiIp = getWifiIp();
        if (wifiIp != null) return wifiIp;
        return getAnyInterfaceIp();
    }

    private String getWifiIp() {
        try {
            ConnectivityManager cm = getContext().getSystemService(ConnectivityManager.class);
            if (cm == null) return null;
            for (Network net : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
                LinkProperties lp = cm.getLinkProperties(net);
                if (lp == null) continue;
                for (LinkAddress la : lp.getLinkAddresses()) {
                    InetAddress addr = la.getAddress();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private String getAnyInterfaceIp() {
        try {
            Enumeration<NetworkInterface> nets = NetworkInterface.getNetworkInterfaces();
            while (nets.hasMoreElements()) {
                NetworkInterface ni = nets.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                String name = ni.getName() == null ? "" : ni.getName().toLowerCase(Locale.US);
                // Skip mobile-data interfaces so we don't hand out an
                // unreachable carrier IP when Wi-Fi lookup above fails.
                if (name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("pdp")
                        || name.startsWith("v4-rmnet") || name.startsWith("clat")) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return "127.0.0.1";
    }

    private void copy(InputStream in, OutputStream out, long length) throws IOException {
        byte[] buf = new byte[256 * 1024];
        long left = length;
        while (left > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (n == -1) break;
            out.write(buf, 0, n);
            left -= n;
        }
    }

    private String queryParam(String path, String key) {
        int q = path.indexOf('?');
        if (q < 0) return "";
        String[] parts = path.substring(q + 1).split("&");
        for (String p : parts) {
            int eq = p.indexOf('=');
            if (eq > 0 && key.equals(p.substring(0, eq))) {
                try { return URLDecoder.decode(p.substring(eq + 1), "UTF-8"); } catch (Exception ignored) {}
            }
        }
        return "";
    }

    private String safeName(String name) {
        if (name == null) return "";
        return name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    }

    private String escapeHtml(String value) {
        if (value == null) return "";
        return value.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&#39;");
    }

    private String humanSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        final String[] units = { "KB", "MB", "GB", "TB" };
        double value = bytes;
        int unit = -1;
        do {
            value /= 1024.0;
            unit++;
        } while (value >= 1024.0 && unit < units.length - 1);
        return String.format(Locale.US, value >= 10 ? "%.0f %s" : "%.1f %s", value, units[unit]);
    }

    private String guessMime(String name) {
        String ext = MimeTypeMap.getFileExtensionFromUrl(name);
        String mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase(Locale.US));
        return mime == null ? "application/octet-stream" : mime;
    }

    private static class HttpRequest {
        String method;
        String path;
        long contentLength;
        String range;
        InputStream input;
        byte[] bodyPrefix;
    }
}
