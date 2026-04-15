package com.goodfile.app

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

@CapacitorPlugin(name = "Downloader")
class DownloadPlugin : Plugin() {

    private val executor = Executors.newCachedThreadPool()
    private val mainHandler = Handler(Looper.getMainLooper())

    @PluginMethod
    fun downloadFile(call: PluginCall) {
        val url      = call.getString("url")      ?: return call.reject("url required")
        val fileName = call.getString("fileName") ?: "goodfile_download"

        android.util.Log.d("GoodFile", "downloadFile url=$url fileName=$fileName")

        // Try DownloadManager first — if it fails or times out, fallback to manual download
        if (tryDownloadManager(url, fileName, call)) return

        // DownloadManager not available (disabled on some ROMs) — go straight to manual
        android.util.Log.w("GoodFile", "DownloadManager unavailable, using manual download")
        manualDownload(url, fileName, call)
    }

    // ── Strategy 1: System DownloadManager ──────────────────────────────────
    private fun tryDownloadManager(url: String, fileName: String, call: PluginCall): Boolean {
        return try {
            val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
                ?: return false

            val req = DownloadManager.Request(Uri.parse(url)).apply {
                setTitle(fileName)
                setDescription("Downloading via goodfile")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                addRequestHeader("Cache-Control", "no-cache")
                // Allow HTTP (cleartext) on all versions
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    setAllowedOverMetered(true)
                    setAllowedOverRoaming(true)
                }
                @Suppress("DEPRECATION")
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    allowScanningByMediaScanner()
                }
            }

            val downloadId = dm.enqueue(req)
            android.util.Log.d("GoodFile", "DM enqueued id=$downloadId")

            // Resolve JS immediately so UI can show "Downloading..."
            call.resolve(JSObject().apply {
                put("downloadId", downloadId)
                put("ok", true)
                put("message", "Downloading $fileName...")
            })

            // Register completion receiver
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) {
                    val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                    if (id != downloadId) return
                    try { activity.unregisterReceiver(this) } catch (_: Exception) {}

                    val cursor = dm.query(DownloadManager.Query().setFilterById(downloadId))
                    if (cursor.moveToFirst()) {
                        val statusCol = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS)
                        val reasonCol = cursor.getColumnIndex(DownloadManager.COLUMN_REASON)
                        val status = if (statusCol >= 0) cursor.getInt(statusCol) else -1
                        val reason = if (reasonCol >= 0) cursor.getInt(reasonCol) else -1
                        android.util.Log.d("GoodFile", "DM complete status=$status reason=$reason")

                        if (status == DownloadManager.STATUS_SUCCESSFUL) {
                            notifyListeners("downloadComplete", JSObject().apply {
                                put("fileName", fileName)
                                put("status", "complete")
                                put("method", "DownloadManager")
                            })
                        } else {
                            android.util.Log.w("GoodFile", "DM failed reason=$reason — trying manual download")
                            // DM failed silently — fallback to manual download
                            manualDownload(url, fileName, null)
                        }
                    }
                    cursor.close()
                }
            }

            val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                activity.registerReceiver(receiver, filter)
            }

            // Safety timeout: if DM doesn't fire within 30s, try manual
            mainHandler.postDelayed({
                val cursor = dm.query(DownloadManager.Query().setFilterById(downloadId))
                val stillPending = cursor.moveToFirst() && run {
                    val col = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS)
                    val s = if (col >= 0) cursor.getInt(col) else -1
                    s == DownloadManager.STATUS_PENDING || s == DownloadManager.STATUS_RUNNING
                }
                cursor.close()
                if (stillPending) {
                    android.util.Log.w("GoodFile", "DM timeout — falling back to manual")
                    try { activity.unregisterReceiver(receiver) } catch (_: Exception) {}
                    dm.remove(downloadId)
                    manualDownload(url, fileName, null)
                }
            }, 30_000)

            true
        } catch (e: Exception) {
            android.util.Log.e("GoodFile", "DM error: ${e.message}")
            false
        }
    }

    // ── Strategy 2: Manual HTTP download via HttpURLConnection ──────────────
    // Works on ALL Android versions, bypasses DownloadManager issues entirely
    private fun manualDownload(url: String, fileName: String, call: PluginCall?) {
        android.util.Log.d("GoodFile", "manualDownload start url=$url")

        // Resolve call immediately if not already resolved
        call?.resolve(JSObject().apply {
            put("ok", true)
            put("message", "Downloading $fileName...")
        })

        executor.execute {
            try {
                val destDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                destDir.mkdirs()

                // Handle filename collisions
                var destFile = File(destDir, fileName)
                if (destFile.exists()) {
                    val dot = fileName.lastIndexOf('.')
                    val base = if (dot > 0) fileName.substring(0, dot) else fileName
                    val ext  = if (dot > 0) fileName.substring(dot) else ""
                    var n = 1
                    while (destFile.exists()) {
                        destFile = File(destDir, "${base}(${n})${ext}")
                        n++
                    }
                }

                val conn = URL(url).openConnection() as HttpURLConnection
                conn.apply {
                    requestMethod = "GET"
                    connectTimeout = 15_000
                    readTimeout = 60_000
                    setRequestProperty("Cache-Control", "no-cache")
                    instanceFollowRedirects = true
                }
                conn.connect()

                val responseCode = conn.responseCode
                android.util.Log.d("GoodFile", "manualDownload HTTP $responseCode")

                if (responseCode !in 200..299) {
                    throw Exception("HTTP $responseCode")
                }

                val totalBytes = conn.contentLengthLong
                var downloadedBytes = 0L

                FileOutputStream(destFile).use { out ->
                    conn.inputStream.use { inp ->
                        val buf = ByteArray(8192)
                        var n: Int
                        while (inp.read(buf).also { n = it } != -1) {
                            out.write(buf, 0, n)
                            downloadedBytes += n
                        }
                    }
                }

                android.util.Log.d("GoodFile", "manualDownload done: ${destFile.absolutePath} ${downloadedBytes}B")

                // Notify media scanner so file appears in Downloads app
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        android.media.MediaScannerConnection.scanFile(
                            activity, arrayOf(destFile.absolutePath), null, null
                        )
                    } else {
                        @Suppress("DEPRECATION")
                        activity.sendBroadcast(
                            Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(destFile))
                        )
                    }
                } catch (_: Exception) {}

                mainHandler.post {
                    notifyListeners("downloadComplete", JSObject().apply {
                        put("fileName", destFile.name)
                        put("status", "complete")
                        put("method", "manual")
                        put("path", destFile.absolutePath)
                    })
                }

            } catch (e: Exception) {
                android.util.Log.e("GoodFile", "manualDownload error: ${e.message}")
                mainHandler.post {
                    notifyListeners("downloadComplete", JSObject().apply {
                        put("fileName", fileName)
                        put("status", "failed")
                        put("error", e.message ?: "Unknown error")
                    })
                }
            }
        }
    }
}