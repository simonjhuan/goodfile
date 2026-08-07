package com.goodfile.app;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "Nsd")
public class NsdPlugin extends Plugin {
    private static final String SERVICE_TYPE = "_goodfile._tcp.";
    private final Handler main = new Handler(Looper.getMainLooper());

    private NsdManager nsdManager;
    private NsdManager.RegistrationListener registrationListener;
    private NsdManager.DiscoveryListener discoveryListener;
    private final AtomicBoolean resolving = new AtomicBoolean(false);
    private final ConcurrentLinkedQueue<NsdServiceInfo> resolveQueue = new ConcurrentLinkedQueue<>();
    private volatile String registeredName = null;

    private NsdManager getNsdManager() {
        if (nsdManager == null) {
            nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        }
        return nsdManager;
    }

    @PluginMethod
    public void register(PluginCall call) {
        int port = call.getInt("port", 8080);
        String deviceName = call.getString("deviceName", android.os.Build.MODEL);
        String fileName = call.getString("fileName", "");
        String tok = call.getString("token", "");

        unregisterInternal();

        NsdServiceInfo info = new NsdServiceInfo();
        // Service name: sanitize to ASCII (NSD rejects non-ASCII)
        String svcName = deviceName.replaceAll("[^\\x20-\\x7E]", "").trim();
        if (svcName.isEmpty()) svcName = "goodfile";
        info.setServiceName(svcName);
        info.setServiceType(SERVICE_TYPE);
        info.setPort(port);
        info.setAttribute("device", safeAttr(deviceName));
        info.setAttribute("file", safeAttr(fileName));
        if (tok != null && !tok.isEmpty()) info.setAttribute("tok", safeAttr(tok));

        registrationListener = new NsdManager.RegistrationListener() {
            @Override public void onRegistrationFailed(NsdServiceInfo i, int code) {
                main.post(() -> call.reject("NSD registration failed: " + code));
            }
            @Override public void onUnregistrationFailed(NsdServiceInfo i, int code) {}
            @Override public void onServiceRegistered(NsdServiceInfo i) {
                registeredName = i.getServiceName();
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("name", registeredName);
                main.post(() -> call.resolve(ret));
            }
            @Override public void onServiceUnregistered(NsdServiceInfo i) {
                registeredName = null;
            }
        };

        try {
            getNsdManager().registerService(info, NsdManager.PROTOCOL_DNS_SD, registrationListener);
        } catch (Exception e) {
            registrationListener = null;
            call.reject("register error: " + e.getMessage());
        }
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        unregisterInternal();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        stopDiscoveryInternal();
        resolveQueue.clear();
        resolving.set(false);

        discoveryListener = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                main.post(() -> call.reject("Discovery start failed: " + errorCode));
            }
            @Override public void onStopDiscoveryFailed(String serviceType, int errorCode) {}
            @Override public void onDiscoveryStarted(String serviceType) {
                JSObject ret = new JSObject();
                ret.put("ok", true);
                main.post(() -> call.resolve(ret));
            }
            @Override public void onDiscoveryStopped(String serviceType) {}
            @Override public void onServiceFound(NsdServiceInfo info) {
                // Skip our own service
                if (registeredName != null && registeredName.equals(info.getServiceName())) return;
                resolveQueue.add(info);
                drainResolveQueue();
            }
            @Override public void onServiceLost(NsdServiceInfo info) {
                JSObject ev = new JSObject();
                ev.put("event", "lost");
                ev.put("serviceName", info.getServiceName());
                main.post(() -> notifyListeners("serviceFound", ev));
            }
        };

        try {
            getNsdManager().discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        } catch (Exception e) {
            discoveryListener = null;
            call.reject("startDiscovery error: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        stopDiscoveryInternal();
        resolveQueue.clear();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    // ── internals ──────────────────────────────────────────────

    private void drainResolveQueue() {
        if (!resolving.compareAndSet(false, true)) return;
        NsdServiceInfo info = resolveQueue.poll();
        if (info == null) { resolving.set(false); return; }

        try {
            getNsdManager().resolveService(info, new NsdManager.ResolveListener() {
                @Override public void onResolveFailed(NsdServiceInfo i, int errorCode) {
                    resolving.set(false);
                    drainResolveQueue();
                }
                @Override public void onServiceResolved(NsdServiceInfo i) {
                    String ip = i.getHost() != null ? i.getHost().getHostAddress() : null;
                    int port = i.getPort();
                    Map<String, byte[]> attrs = i.getAttributes();
                    String device = attrStr(attrs, "device");
                    String file = attrStr(attrs, "file");
                    String tok = attrStr(attrs, "tok");
                    if (device == null || device.isEmpty()) device = i.getServiceName();
                    String url = ip != null
                            ? "http://" + ip + ":" + port + "/download"
                              + (tok != null && !tok.isEmpty() ? "?t=" + tok : "")
                            : "";

                    JSObject ev = new JSObject();
                    ev.put("event", "found");
                    ev.put("serviceName", i.getServiceName());
                    ev.put("deviceName", device);
                    ev.put("fileName", file != null ? file : "");
                    ev.put("ip", ip != null ? ip : "");
                    ev.put("port", port);
                    ev.put("url", url);
                    main.post(() -> notifyListeners("serviceFound", ev));

                    resolving.set(false);
                    drainResolveQueue();
                }
            });
        } catch (Exception e) {
            resolving.set(false);
            drainResolveQueue();
        }
    }

    private void unregisterInternal() {
        if (registrationListener != null) {
            try { getNsdManager().unregisterService(registrationListener); } catch (Exception ignored) {}
            registrationListener = null;
        }
    }

    private void stopDiscoveryInternal() {
        if (discoveryListener != null) {
            try { getNsdManager().stopServiceDiscovery(discoveryListener); } catch (Exception ignored) {}
            discoveryListener = null;
        }
    }

    private static String attrStr(Map<String, byte[]> attrs, String key) {
        if (attrs == null) return null;
        byte[] v = attrs.get(key);
        if (v == null) return null;
        try { return new String(v, "UTF-8"); } catch (Exception e) { return null; }
    }

    private static String safeAttr(String s) {
        if (s == null) return "";
        // TXT record value: max 255 bytes
        byte[] b;
        try { b = s.getBytes("UTF-8"); } catch (Exception e) { return ""; }
        if (b.length <= 255) return s;
        // Truncate to 255 bytes
        return new String(b, 0, 255, java.nio.charset.StandardCharsets.UTF_8);
    }
}
