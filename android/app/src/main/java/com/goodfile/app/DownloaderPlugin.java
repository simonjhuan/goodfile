package com.goodfile.app;

import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "Downloader")
public class DownloaderPlugin extends Plugin {
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private volatile HttpURLConnection activeConnection;
    private volatile boolean cancelled;

    @PluginMethod public void downloadFile(PluginCall call) { startDownload(call); }
    @PluginMethod public void resumeDownload(PluginCall call) { startDownload(call); }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        cancelled = true;
        HttpURLConnection connection = activeConnection;
        if (connection != null) connection.disconnect();
        notifyListeners("downloadCancelled", new JSObject());
        call.resolve(new JSObject().put("cancelled", true));
    }

    private void startDownload(PluginCall call) {
        String url = call.getString("url", "");
        String fileName = safeName(call.getString("fileName", "goodfile_download"));
        if (url.isEmpty()) { call.reject("Missing URL"); return; }
        cancelled = false;
        pool.execute(() -> runDownload(call, url, fileName));
    }

    private void runDownload(PluginCall call, String url, String fileName) {
        File part = new File(getContext().getCacheDir(), "goodfile_" + key(url) + ".part");
        long existing = part.exists() ? part.length() : 0;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            activeConnection = conn;
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(300000);
            conn.setRequestProperty("Accept-Encoding", "identity");
            if (existing > 0) conn.setRequestProperty("Range", "bytes=" + existing + "-");
            conn.connect();
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new Exception("HTTP " + code);
            String responseName = contentDispositionName(conn.getHeaderField("Content-Disposition"));
            if (!responseName.isEmpty()) fileName = safeName(responseName);

            boolean resumed = existing > 0 && code == HttpURLConnection.HTTP_PARTIAL;
            if (!resumed) existing = 0;
            long responseLength = conn.getContentLengthLong();
            long total = responseLength > 0 ? existing + responseLength : -1;
            JSObject started = new JSObject();
            started.put("fileName", fileName);
            started.put("resumedBytes", existing);
            started.put("total", total);
            notifyListeners("downloadStarted", started);

            long done = existing;
            long startedAt = System.currentTimeMillis();
            long lastEventAt = 0;
            try (InputStream in = new BufferedInputStream(conn.getInputStream());
                 OutputStream out = new BufferedOutputStream(new FileOutputStream(part, resumed))) {
                byte[] buf = new byte[256 * 1024];
                int n;
                while (!cancelled && (n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    done += n;
                    long now = System.currentTimeMillis();
                    if (now - lastEventAt >= 250 || (total > 0 && done >= total)) {
                        lastEventAt = now;
                        emitProgress(done, total, existing, startedAt);
                    }
                }
            }
            if (cancelled) throw new CancelledException();
            OutputTarget target = saveCompletedFile(fileName, part);
            part.delete();
            JSObject ev = completion(target);
            notifyListeners("downloadComplete", ev);
            call.resolve(ev);
        } catch (CancelledException e) {
            call.reject("cancelled");
        } catch (Exception e) {
            if (cancelled) {
                call.reject("cancelled");
                return;
            }
            JSObject ev = new JSObject();
            ev.put("error", e.getMessage() == null ? "Download failed" : e.getMessage());
            ev.put("resumable", part.exists() && part.length() > 0);
            ev.put("bytes", part.exists() ? part.length() : 0);
            notifyListeners("downloadError", ev);
            call.reject("Download failed: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
            activeConnection = null;
        }
    }

    private void emitProgress(long done, long total, long resumedAt, long startedAt) {
        long elapsed = Math.max(1, System.currentTimeMillis() - startedAt);
        long speed = Math.max(0, done - resumedAt) * 1000L / elapsed;
        long eta = total > 0 && speed > 0 ? Math.max(0, (total - done) / speed) : -1;
        int progress = total > 0 ? (int) Math.min(100, done * 100L / total) : -1;
        JSObject ev = new JSObject();
        ev.put("progress", progress);
        ev.put("bytes", done);
        ev.put("total", total);
        ev.put("speed", speed);
        ev.put("eta", eta);
        notifyListeners("downloadProgress", ev);
    }

    private OutputTarget saveCompletedFile(String fileName, File part) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/goodfile");
            Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new Exception("Cannot create download item");
            try (InputStream in = new FileInputStream(part); OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new Exception("Cannot open download output");
                copy(in, out);
            }
            return new OutputTarget(fileName, "Downloads/goodfile/" + fileName, uri, part.length());
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "goodfile");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("Cannot create download folder");
        File file = uniqueFile(dir, fileName);
        try (InputStream in = new FileInputStream(part); OutputStream out = new FileOutputStream(file)) { copy(in, out); }
        return new OutputTarget(file.getName(), file.getAbsolutePath(), Uri.fromFile(file), file.length());
    }

    private void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[256 * 1024];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
    }

    private JSObject completion(OutputTarget target) {
        JSObject ev = new JSObject();
        ev.put("message", "โหลดสำเร็จ");
        ev.put("fileName", target.displayName);
        ev.put("path", target.path);
        ev.put("uri", target.uri.toString());
        ev.put("size", target.size);
        return ev;
    }

    private String key(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes("UTF-8"));
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < 12; i++) out.append(String.format("%02x", digest[i]));
            return out.toString();
        } catch (Exception e) { return Integer.toHexString(value.hashCode()); }
    }

    private File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        int i = 1;
        do { f = new File(dir, base + "_" + i++ + ext); } while (f.exists());
        return f;
    }

    private String safeName(String name) {
        if (name == null || name.trim().isEmpty()) return "goodfile_download";
        return name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    }

    private String contentDispositionName(String value) {
        if (value == null) return "";
        int marker = value.toLowerCase().indexOf("filename=");
        if (marker < 0) return "";
        String name = value.substring(marker + 9).trim();
        if (name.startsWith("\"") && name.endsWith("\"") && name.length() > 1) {
            name = name.substring(1, name.length() - 1);
        }
        return name;
    }
    private static class OutputTarget {
        final String displayName;
        final String path;
        final Uri uri;
        final long size;
        OutputTarget(String displayName, String path, Uri uri, long size) {
            this.displayName = displayName;
            this.path = path;
            this.uri = uri;
            this.size = size;
        }
    }

    private static class CancelledException extends Exception {}
}
