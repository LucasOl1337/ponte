package app.ponte.omarchy;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import java.io.*;
import java.net.URI;
import java.util.Arrays;

public final class MainActivity extends Activity {
    private static final String NATIVE_PAUSE = "window.dispatchEvent(new Event('ponte-native-pause')); true;";
    private LoopbackProxy proxy;
    private WebView browser;
    private FrameLayout root;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private PermissionRequest pendingPermission;
    private final MicrophonePermissionGate microphonePermission = new MicrophonePermissionGate();
    private int pauseGeneration;
    private SharedPreferences preferences;
    private boolean paused;
    private boolean destroyed;
    private boolean reloadOnResume;
    private String origin;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("ponte-pairing", MODE_PRIVATE);
        consumePairingIntent(getIntent());
        getWindow().setStatusBarColor(Color.rgb(21, 23, 20));
        getWindow().setNavigationBarColor(Color.rgb(21, 23, 20));
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(21, 23, 20));
        setContentView(root);
        try (InputStream certificate = getAssets().open("pc-certificate.pem")) {
            proxy = new LoopbackProxy(URI.create(BuildConfig.UPSTREAM), certificate, 18987, mac -> {
                if (mac != null && !mac.isEmpty()) {
                    preferences.edit().putString("wol_mac", mac).apply();
                }
            });
            origin = proxy.origin();
        } catch (Exception error) {
            showMessage(nativeText("Ponte could not start", "Não foi possível abrir o Ponte"), nativeText("The app connection is unavailable. Close Ponte and open it again.", "A conexão local do app está indisponível. Feche o Ponte e abra novamente."), false);
            return;
        }
        configureBrowser();
        loadHome();
    }

    private boolean consumePairingIntent(Intent intent) {
        if (intent == null) return false;
        String supplied = intent.getStringExtra("pair_token");
        intent.removeExtra("pair_token");
        if (preferences.getBoolean("intent_pairing_consumed", false) || supplied == null || !supplied.matches("[A-Za-z0-9_-]{32,128}")) return false;
        preferences.edit().putString("pair_token", supplied).putBoolean("intent_pairing_consumed", true).apply();
        return true;
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        boolean paired = consumePairingIntent(intent);
        setIntent(intent);
        if (paired && browser != null) loadHome();
    }

    private void configureBrowser() {
        browser = new WebView(this);
        browser.setBackgroundColor(Color.rgb(21, 23, 20));
        WebSettings settings = browser.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSafeBrowsingEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " PonteAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false);
        WebView.setWebContentsDebuggingEnabled(false);
        browser.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                Uri address = Uri.parse(view.getUrl() == null ? url : view.getUrl());
                if (ownOrigin(address) && (address.getFragment() == null || !address.getFragment().startsWith("pair="))) {
                    // The web app consumed the fragment into its private DOM
                    // storage. Keep no native copy that could undo an unpair.
                    preferences.edit().remove("pair_token").putBoolean("intent_pairing_consumed", true).apply();
                }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !ownOrigin(request.getUrl()); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return allowedResource(request.getUrl()) ? null : blockedResource();
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !paused && !destroyed) showUnavailable();
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (request.isForMainFrame() && error.getStatusCode() >= 400 && !paused && !destroyed) showUnavailable();
            }
        });
        ServiceWorkerController.getInstance().getServiceWorkerWebSettings().setAllowFileAccess(false);
        ServiceWorkerController.getInstance().getServiceWorkerWebSettings().setAllowContentAccess(false);
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return allowedResource(request.getUrl()) ? null : blockedResource();
            }
        });
        browser.setWebChromeClient(new WebChromeClient() {
            @Override public void onReceivedTitle(WebView view, String title) {
                if (destroyed || !ownOrigin(Uri.parse(view.getUrl() == null ? "" : view.getUrl()))) return;
                view.evaluateJavascript("document.documentElement.lang", value -> {
                    if (destroyed || !ownOrigin(Uri.parse(view.getUrl() == null ? "" : view.getUrl()))) return;
                    if ("\"en\"".equals(value) || "\"pt-BR\"".equals(value)) {
                        preferences.edit().putString("language", "\"pt-BR\"".equals(value) ? "pt" : "en").apply();
                    }
                });
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (destroyed || paused || !ownOrigin(request.getOrigin())
                            || request.getResources().length != 1 || !Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        request.deny(); return;
                    }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        cancelMicrophonePermission();
                        pendingPermission = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, microphonePermission.begin());
                    }
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingPermission == request) { pendingPermission = null; microphonePermission.cancel(); }
            }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreen != null || paused) { callback.onCustomViewHidden(); return; }
                fullscreen = view; fullscreenCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(-1, -1));
                browser.setVisibility(View.GONE);
                getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            }
            @Override public void onHideCustomView() { exitFullscreen(); }
        });
        root.addView(browser, new FrameLayout.LayoutParams(-1, -1));
    }

    private boolean ownOrigin(Uri uri) {
        return uri != null && "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort() == 18987 && uri.getUserInfo() == null;
    }
    private boolean allowedResource(Uri uri) { return ownOrigin(uri) || (uri != null && uri.toString().startsWith("blob:" + origin + "/")); }
    private WebResourceResponse blockedResource() {
        return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", null, new ByteArrayInputStream(new byte[0]));
    }
    private void loadHome() {
        if (browser == null || destroyed) return;
        root.removeAllViews(); root.addView(browser, new FrameLayout.LayoutParams(-1, -1)); browser.setVisibility(View.VISIBLE);
        String token = preferences.getString("pair_token", "");
        String url = origin + "/";
        if (token.matches("[A-Za-z0-9_-]{32,128}")) url += "#pair=" + Uri.encode(token);
        browser.loadUrl(url);
        reloadOnResume = false;
    }
    private void showUnavailable() {
        runOnUiThread(() -> showMessage(nativeText("Your PC has not responded", "Seu PC ainda não respondeu"), nativeText("Connect Tailscale on your phone and keep your PC awake. Then try again.", "Conecte o Tailscale no celular e mantenha o PC ligado. Depois, tente novamente."), true));
    }
    private String nativeText(String english, String portuguese) {
        return "pt".equals(preferences.getString("language", "en")) ? portuguese : english;
    }
    private void showMessage(String title, String detail, boolean retry) {
        if (destroyed) return;
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL); panel.setGravity(Gravity.CENTER_VERTICAL);
        int padding = (int) (28 * getResources().getDisplayMetrics().density);
        panel.setPadding(padding, padding, padding, padding);
        TextView brand = new TextView(this); brand.setText("ponte."); brand.setTextSize(34); brand.setTextColor(Color.rgb(213, 248, 136)); panel.addView(brand);
        TextView heading = new TextView(this); heading.setText(title); heading.setTextSize(26); heading.setTextColor(Color.rgb(244, 242, 233)); heading.setPadding(0, padding, 0, padding / 2); panel.addView(heading);
        TextView text = new TextView(this); text.setText(detail); text.setTextSize(16); text.setTextColor(Color.rgb(163, 170, 153)); panel.addView(text);
        if (retry) {
            String wolMac = preferences.getString("wol_mac", null);
            if (wolMac != null && !wolMac.isEmpty()) {
                Button wolButton = new Button(this);
                wolButton.setText(nativeText("Turn on PC", "Ligar PC"));
                TextView wolStatus = new TextView(this);
                wolStatus.setTextSize(14);
                wolStatus.setTextColor(Color.rgb(213, 248, 136));
                wolStatus.setPadding(0, padding / 4, 0, padding / 4);
                wolStatus.setVisibility(View.GONE);
                wolButton.setOnClickListener(v -> {
                    wolButton.setEnabled(false);
                    wolStatus.setText(nativeText("Packet sent, wait ~30 s", "Pacote enviado, aguarde ~30 s"));
                    wolStatus.setVisibility(View.VISIBLE);
                    new Thread(() -> {
                        try {
                            WakeOnLan.sendMagicPackets(wolMac);
                        } catch (Exception ignored) { }
                    }, "ponte-wol-send").start();
                    wolButton.postDelayed(() -> {
                        if (!destroyed) wolButton.setEnabled(true);
                    }, 30000);
                });
                panel.addView(wolButton);
                panel.addView(wolStatus);
            }
            Button button = new Button(this);
            button.setText(nativeText("Try again", "Tentar novamente"));
            button.setOnClickListener(v -> loadHome());
            panel.addView(button);
        }
        root.removeAllViews(); root.addView(panel, new FrameLayout.LayoutParams(-1, -1));
    }
    private void exitFullscreen() {
        if (fullscreen != null) { root.removeView(fullscreen); fullscreen = null; }
        if (browser != null) browser.setVisibility(View.VISIBLE);
        if (fullscreenCallback != null) { WebChromeClient.CustomViewCallback callback = fullscreenCallback; fullscreenCallback = null; callback.onCustomViewHidden(); }
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
    }
    private void cancelMicrophonePermission() {
        microphonePermission.cancel();
        PermissionRequest request = pendingPermission;
        pendingPermission = null;
        if (request != null) request.deny();
    }
    private void resolveMicrophonePermission() {
        Boolean granted = microphonePermission.takeDecision();
        if (granted == null) return;
        PermissionRequest request = pendingPermission;
        pendingPermission = null;
        if (request == null) return;
        if (granted && !paused && !destroyed && ownOrigin(request.getOrigin())
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else request.deny();
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (microphonePermission.receive(requestCode, results.length == 1 && results[0] == PackageManager.PERMISSION_GRANTED)) resolveMicrophonePermission();
    }
    private void pauseWebContent(boolean awaitingMicrophonePermission) {
        if (browser == null) return;
        final int generation = ++pauseGeneration;
        String script = awaitingMicrophonePermission
            ? "window.dispatchEvent(new CustomEvent('ponte-native-pause',{detail:{awaitingMicrophonePermission:true}})); true;"
            : NATIVE_PAUSE;
        final boolean[] acknowledged = {false};
        browser.evaluateJavascript(script, value -> acknowledged[0] = "true".equals(value));
        if (!awaitingMicrophonePermission) {
            handler.postDelayed(() -> {
                if (paused && !destroyed && pauseGeneration == generation && !acknowledged[0] && browser != null) {
                    browser.stopLoading(); browser.loadUrl("about:blank"); reloadOnResume = true;
                }
            }, 300);
        }
    }
    @Override protected void onPause() {
        paused = true;
        boolean ownPermissionDialog = microphonePermission.pause() && pendingPermission != null;
        if (!ownPermissionDialog) cancelMicrophonePermission();
        // Dispatch media cleanup before touching network lifecycle. The Android
        // permission dialog may pause us; onStop distinguishes leaving the app.
        pauseWebContent(ownPermissionDialog);
        if (proxy != null) proxy.setPaused(true);
        exitFullscreen();
        if (browser != null) browser.onPause();
        super.onPause();
    }
    @Override protected void onStop() {
        microphonePermission.stop();
        cancelMicrophonePermission();
        pauseWebContent(false);
        super.onStop();
    }
    @Override protected void onResume() {
        super.onResume(); paused = false; ++pauseGeneration;
        microphonePermission.resume();
        if (proxy != null) proxy.setPaused(false);
        if (browser != null) {
            browser.onResume();
            if (reloadOnResume) loadHome();
            else browser.evaluateJavascript("window.dispatchEvent(new Event('ponte-native-resume'));", null);
        }
        resolveMicrophonePermission();
    }
    @Override public void onBackPressed() {
        if (fullscreen != null) { exitFullscreen(); return; }
        if (browser != null && browser.canGoBack()) { browser.goBack(); return; }
        super.onBackPressed();
    }
    @Override protected void onDestroy() {
        destroyed = true; handler.removeCallbacksAndMessages(null);
        cancelMicrophonePermission();
        if (proxy != null) proxy.close();
        if (browser != null) { root.removeView(browser); browser.stopLoading(); browser.destroy(); browser = null; }
        super.onDestroy();
    }
}
