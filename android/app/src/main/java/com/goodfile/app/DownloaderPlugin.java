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
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "Downloader")
public class DownloaderPlugin extends Plugin {
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void downloadFile(PluginCall call) {
        String url = call.getString("url", "");
        String fileName = safeName(call.getString("fileName", "goodfile_download"));
        if (url.isEmpty()) {
            call.reject("Missing URL");
            return;
        }
        pool.execute(() -> {
            File outFile = null;
            Uri outUri = null;
            try {
                OutputTarget target = openOutput(fileName);
                outFile = target.file;
                outUri = target.uri;
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(300000);
                conn.connect();
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) throw new Exception("HTTP " + code);
                JSObject started = new JSObject();
                started.put("fileName", target.displayName);
                notifyListeners("downloadStarted", started);
                long total = conn.getContentLengthLong();
                long done = 0;
                byte[] buf = new byte[256 * 1024];
                int lastPct = -1;
                try (InputStream in = new BufferedInputStream(conn.getInputStream());
                     OutputStream out = target.output) {
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        done += n;
                        target.bytes = done;
                        if (total > 0) {
                            int pct = (int) Math.min(100, (done * 100) / total);
                            if (pct != lastPct && (pct % 2 == 0 || pct == 100)) {
                                lastPct = pct;
                                JSObject ev = new JSObject();
                                ev.put("progress", pct);
                                ev.put("bytes", done);
                                ev.put("total", total);
                                notifyListeners("downloadProgress", ev);
                            }
                        }
                    }
                } finally {
                    conn.disconnect();
                }
                JSObject ev = new JSObject();
                ev.put("fileName", target.displayName);
                ev.put("path", target.path);
                ev.put("uri", outUri == null ? "" : outUri.toString());
                ev.put("size", target.size());
                notifyListeners("downloadComplete", ev);
                JSObject ret = new JSObject();
                ret.put("message", "โหลดสำเร็จ");
                ret.put("fileName", target.displayName);
                ret.put("path", target.path);
                ret.put("uri", outUri == null ? "" : outUri.toString());
                ret.put("size", target.size());
                call.resolve(ret);
            } catch (Exception e) {
                if (outFile != null && outFile.exists() && outFile.length() == 0) outFile.delete();
                JSObject ev = new JSObject();
                ev.put("error", e.getMessage());
                notifyListeners("downloadError", ev);
                call.reject("Download failed: " + e.getMessage());
            }
        });
    }

    private OutputTarget openOutput(String fileName) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/goodfile");
            Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new Exception("Cannot create download item");
            OutputStream out = getContext().getContentResolver().openOutputStream(uri);
            if (out == null) throw new Exception("Cannot open download output");
            return new OutputTarget(fileName, "Downloads/goodfile/" + fileName, uri, null, out);
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "goodfile");
        if (!dir.exists()) dir.mkdirs();
        File file = uniqueFile(dir, fileName);
        return new OutputTarget(file.getName(), file.getAbsolutePath(), Uri.fromFile(file), file, new FileOutputStream(file));
    }

    private File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        int i = 1;
        do {
            f = new File(dir, base + "_" + i + ext);
            i++;
        } while (f.exists());
        return f;
    }

    private String safeName(String name) {
        if (name == null || name.trim().isEmpty()) return "goodfile_download";
        return name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    }

    private static class OutputTarget {
        final String displayName;
        final String path;
        final Uri uri;
        final File file;
        final OutputStream output;
        long bytes;

        OutputTarget(String displayName, String path, Uri uri, File file, OutputStream output) {
            this.displayName = displayName;
            this.path = path;
            this.uri = uri;
            this.file = file;
            this.output = output;
        }

        long size() {
            return file == null ? bytes : file.length();
        }
    }
}
