package com.goodfile.app

import android.content.Context
import android.net.Uri
import android.net.wifi.WifiManager
import android.text.format.Formatter
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.net.NetworkInterface

@CapacitorPlugin(name = "FileServer")
class FileServerPlugin : Plugin() {

    private var server: QRDropServer? = null

    @PluginMethod
    fun startServer(call: PluginCall) {
        val uriStr   = call.getString("uri")     ?: return call.reject("uri required")
        val fileName = call.getString("fileName") ?: "file"
        val mimeType = call.getString("mimeType") ?: "application/octet-stream"
        val port     = call.getInt("port", 8080)!!

        // stop server เดิมก่อน แล้วรอให้ port release
        try {
            server?.stop()
            server = null
            Thread.sleep(300) // รอ port 8080 release
        } catch (_: Exception) {}

        val ip = getLocalIP() ?: return call.reject("ไม่พบ IP — เชื่อม Wi-Fi ก่อน")

        android.util.Log.d("GoodFile", "startServer uri=$uriStr fileName=$fileName")

        val resolvedFile: File? = resolveToFile(uriStr)

        if (resolvedFile == null || !resolvedFile.exists()) {
            android.util.Log.e("GoodFile", "File not found: $uriStr")
            return call.reject("ไม่พบไฟล์: $uriStr")
        }

        android.util.Log.d("GoodFile", "File OK: ${resolvedFile.absolutePath} ${resolvedFile.length()}B")

        // ลอง port 8080-8090 จนกว่าจะได้
        var actualPort = port
        var started = false
        for (tryPort in port..(port + 10)) {
            try {
                server = QRDropServer(activity, resolvedFile, Uri.parse(uriStr), fileName, mimeType, tryPort)
                server!!.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
                actualPort = tryPort
                started = true
                break
            } catch (e: Exception) {
                android.util.Log.w("GoodFile", "Port $tryPort busy, trying next...")
                try { server?.stop() } catch (_: Exception) {}
            }
        }
        if (!started) {
            call.reject("เปิด server ไม่ได้: ทุก port ถูกใช้งาน")
            return
        }
        val url = "http://$ip:$actualPort/download"
        android.util.Log.d("GoodFile", "Server started: $url")
        call.resolve(JSObject().apply {
            put("ip", ip); put("port", actualPort); put("url", url)
            put("fileName", fileName); put("ok", true)
        })
    }

    @PluginMethod
    fun stopServer(call: PluginCall) {
        try { server?.stop() } catch (_: Exception) {}
        server = null
        call.resolve()
    }

    @PluginMethod
    fun getIP(call: PluginCall) {
        call.resolve(JSObject().apply { put("ip", getLocalIP() ?: "unknown") })
    }

    private fun resolveToFile(uriStr: String): File? {
        return try {
            val uri = Uri.parse(uriStr)
            when (uri.scheme) {
                "file" -> {
                    // file:///data/user/0/com.goodfile.app/cache/filename
                    File(uri.path ?: return null)
                }
                "content" -> {
                    // content:// — copy to cache
                    val out = File(activity.cacheDir, "gf_${System.currentTimeMillis()}")
                    activity.contentResolver.openInputStream(uri)?.use { it.copyTo(out.outputStream()) }
                    out
                }
                else -> File(uriStr)
            }
        } catch (e: Exception) {
            android.util.Log.e("GoodFile", "resolveToFile: ${e.message}")
            null
        }
    }

    // clean hostAddress — Android บางรุ่น return "192.168.1.5%wlan0" หรือ "192.168.7."
    private fun cleanIP(raw: String?): String? {
        if (raw == null) return null
        val clean = raw.substringBefore('%').trim().trimEnd('.')
        // ตรวจว่าเป็น IPv4 จริงๆ (x.x.x.x)
        val parts = clean.split('.')
        if (parts.size != 4) return null
        if (parts.any { it.isEmpty() || it.toIntOrNull() == null }) return null
        return clean
    }

    private fun getLocalIP(): String? {
        // Strategy 1: wlan0 ก่อนเสมอ — WiFi interface จริง ไม่ใช่ p2p หรือ mobile data
        try {
            val wlanIfaces = listOf("wlan0", "wlan1", "eth0", "eth1")
            for (name in wlanIfaces) {
                val ni = NetworkInterface.getByName(name) ?: continue
                if (!ni.isUp || ni.isLoopback) continue
                val ip = ni.inetAddresses.toList()
                    .firstOrNull { addr ->
                        !addr.isLoopbackAddress &&
                                !addr.isLinkLocalAddress &&
                                addr.hostAddress?.contains(':') == false
                    }?.let { cleanIP(it.hostAddress) }
                if (ip != null) {
                    android.util.Log.d("GoodFile", "getLocalIP (wlan0): $ip")
                    return ip
                }
            }
        } catch (_: Exception) {}

        // Strategy 2: NetworkInterface scan — prefer private LAN ranges
        // (ไม่รวม p2p, rmnet_data, mobile data)
        try {
            val result = NetworkInterface.getNetworkInterfaces()
                ?.toList()
                ?.filter { ni ->
                    ni.isUp && !ni.isLoopback && !ni.isVirtual &&
                            !ni.name.startsWith("p2p") &&     // WiFi Direct
                            !ni.name.startsWith("rmnet") &&   // Mobile data
                            !ni.name.startsWith("dummy") &&
                            !ni.name.startsWith("ham")        // Hamachi VPN
                }
                ?.flatMap { ni -> ni.inetAddresses.toList() }
                ?.filter { addr ->
                    !addr.isLoopbackAddress &&
                            !addr.isLinkLocalAddress &&
                            addr.hostAddress?.contains(':') == false
                }
                ?.mapNotNull { cleanIP(it.hostAddress) }
                ?.firstOrNull { ip ->
                    ip != null && (
                            ip.startsWith("192.168.") ||
                                    ip.startsWith("10.") ||
                                    Regex("^172\\.(1[6-9]|2[0-9]|3[01])\\.").containsMatchIn(ip)
                            )
                }
            if (result != null) {
                android.util.Log.d("GoodFile", "getLocalIP (NetworkInterface): $result")
                return result
            }
        } catch (_: Exception) {}

        // Strategy 2: WifiManager (deprecated on API 31+ but still works as fallback)
        try {
            @Suppress("DEPRECATION")
            val wm = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val ipInt = wm.connectionInfo.ipAddress
            if (ipInt != 0) {
                val ip = Formatter.formatIpAddress(ipInt)
                if (ip != "0.0.0.0" && !ip.startsWith("127.") && !ip.startsWith("169.254.")) {
                    android.util.Log.d("GoodFile", "getLocalIP (WifiManager): $ip")
                    return ip
                }
            }
        } catch (_: Exception) {}

        // Strategy 3: Any non-loopback IPv4 (last resort)
        try {
            val result = NetworkInterface.getNetworkInterfaces()
                ?.toList()
                ?.filter { ni -> ni.isUp && !ni.isLoopback }
                ?.flatMap { ni -> ni.inetAddresses.toList() }
                ?.firstOrNull { addr ->
                    !addr.isLoopbackAddress && addr.hostAddress?.contains(':') == false
                }
                ?.hostAddress
            if (result != null) {
                android.util.Log.d("GoodFile", "getLocalIP (fallback): $result")
                return result
            }
        } catch (_: Exception) {}

        android.util.Log.e("GoodFile", "getLocalIP: ไม่พบ IP — กรุณาเชื่อม Wi-Fi")
        return null
    }

    override fun handleOnDestroy() { try { server?.stop() } catch (_: Exception) {} }
}

class QRDropServer(
    private val context: Context,
    private val resolvedFile: File,
    private val originalUri: Uri,
    private val fileName: String,
    private val mimeType: String,
    port: Int
) : NanoHTTPD(port) {

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri.trimEnd('/')
        return when {
            uri == "/download" || uri == "/get" || uri == "/file" -> serveFile()
            uri == "/api/ping" -> servePing()
            uri == "" || uri == "/" -> landingPage()
            // รองรับ path แปลกๆ ที่ browser อาจส่งมา
            uri.startsWith("/download") || uri.startsWith("/get") -> serveFile()
            else -> landingPage() // ส่ง landing page แทน Not Found — ดีกว่า error
        }
    }

    private fun servePing(): Response {
        val json = """{"app":"goodfile","version":"1.0.0","platform":"android","device":"${android.os.Build.MODEL}","fileName":"$fileName"}"""
        return newFixedLengthResponse(Response.Status.OK, "application/json", json).also {
            it.addHeader("Access-Control-Allow-Origin", "*")
        }
    }

    private fun openStream(): InputStream {
        if (resolvedFile.exists()) return FileInputStream(resolvedFile)
        return context.contentResolver.openInputStream(originalUri)
            ?: throw Exception("Cannot open: $originalUri")
    }

    private fun serveFile(): Response {
        return try {
            val stream = openStream()
            val size = if (resolvedFile.exists()) resolvedFile.length() else -1L
            val resp = if (size > 0)
                newFixedLengthResponse(Response.Status.OK, mimeType, stream, size)
            else
                newChunkedResponse(Response.Status.OK, mimeType, stream)
            resp.addHeader("Content-Disposition", "attachment; filename=\"${fileName.replace("\"","'")}\"")
            resp.addHeader("Access-Control-Allow-Origin", "*")
            resp.addHeader("Cache-Control", "no-cache")
            resp
        } catch (e: Exception) {
            android.util.Log.e("GoodFile", "Serve error: ${e.message}")
            newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Error: ${e.message}")
        }
    }

    private fun landingPage(): Response {
        val html = """<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>goodfile — รับไฟล์</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{
  height:100%;font-family:'Helvetica Neue',sans-serif;
  background:linear-gradient(160deg,#89D4F5 0%,#5BB8EC 50%,#3AA0DE 100%);
  display:flex;align-items:center;justify-content:center;
  padding:24px;
}
.card{
  background:rgba(255,255,255,.22);
  backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
  border:1.5px solid rgba(255,255,255,.55);
  border-radius:28px;
  padding:36px 24px 28px;
  width:100%;max-width:380px;
  text-align:center;
  box-shadow:0 20px 60px rgba(0,0,0,.15),inset 0 1px 0 rgba(255,255,255,.5);
  animation:popin .5s cubic-bezier(.34,1.56,.64,1) both;
}
@keyframes popin{from{transform:scale(.85);opacity:0}to{transform:scale(1);opacity:1}}
.logo{
  font-size:13px;font-weight:800;letter-spacing:3px;text-transform:uppercase;
  color:rgba(255,255,255,.7);margin-bottom:28px;
}
.logo span{color:#52D68A}
.file-icon{font-size:56px;margin-bottom:16px;animation:float 2.5s ease-in-out infinite}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.file-name{
  font-size:18px;font-weight:800;color:#fff;
  word-break:break-all;line-height:1.4;
  margin-bottom:6px;letter-spacing:-.3px;
}
.file-size{
  font-size:13px;font-weight:600;color:rgba(255,255,255,.65);
  margin-bottom:32px;
}
.btn-dl{
  display:block;width:100%;
  background:linear-gradient(135deg,#52D68A,#27B562);
  color:#fff;text-decoration:none;
  padding:18px;border-radius:18px;
  font-size:18px;font-weight:800;letter-spacing:.3px;
  box-shadow:0 8px 28px rgba(39,181,98,.5),inset 0 1px 0 rgba(255,255,255,.3);
  transition:transform .12s,box-shadow .12s;
  -webkit-appearance:none;
}
.btn-dl:active{transform:scale(.97);box-shadow:0 4px 14px rgba(39,181,98,.4)}
.hint{
  margin-top:16px;font-size:11px;font-weight:600;
  color:rgba(255,255,255,.5);letter-spacing:.3px;
}
.badges{
  display:flex;gap:8px;justify-content:center;margin-top:20px;flex-wrap:wrap;
}
.badge{
  font-size:10px;font-weight:700;color:rgba(255,255,255,.65);
  padding:4px 10px;border-radius:100px;
  background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.25);
}
</style>
</head>
<body>
<div class="card">
  <div class="logo"><span>GOOD</span>FILE</div>
  <div class="file-icon">📄</div>
  <div class="file-name">$fileName</div>
  <div class="file-size">พร้อมส่ง · แตะเพื่อรับไฟล์</div>
  <a class="btn-dl" href="/download">⬇&nbsp; รับไฟล์เลย</a>
  <div class="hint">ไฟล์จะบันทึกใน Downloads อัตโนมัติ</div>
  <div class="badges">
    <span class="badge">🔒 ปลอดภัย</span>
    <span class="badge">👁 ไม่ผ่าน cloud</span>
    <span class="badge">⚡ LAN เท่านั้น</span>
  </div>
</div>
<script>
// Auto-detect file type for icon
(function(){
  var name = "$fileName".toLowerCase();
  var icons = {
    jpg:'🖼️',jpeg:'🖼️',png:'🖼️',gif:'🖼️',webp:'🖼️',heic:'🖼️',
    mp4:'🎬',mov:'🎬',avi:'🎬',mkv:'🎬',
    mp3:'🎵',wav:'🎵',aac:'🎵',flac:'🎵',
    pdf:'📕',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',ppt:'📊',pptx:'📊',
    zip:'🗜️',rar:'🗜️',
    apk:'📲',txt:'📋',
  };
  var ext = name.split('.').pop();
  var ic = icons[ext] || '📄';
  document.querySelector('.file-icon').textContent = ic;
})();
</script>
</body>
</html>"""
        return newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", html)
    }
}