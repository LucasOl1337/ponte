package app.ponte.omarchy;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.view.inputmethod.InputMethodManager;
import android.webkit.*;
import android.widget.*;
import java.io.*;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
    // Started by an agent over adb ("--ez ponte.agent true"): show above the
    // lock screen and turn the screen on, so the app can be exercised without
    // unlocking the phone. The rest of the phone stays locked, and the moment
    // this instance leaves the foreground it finishes, so a locked phone never
    // keeps PC control one power-button press away.
    private boolean agentSession;
    // A cold start right after the screen turns on can race the VPN coming
    // back: the first request fails while the tunnel is still waking. Retry a
    // few times quietly before asking the user to.
    private int loadAttempts;
    private boolean loadFailed;
    private boolean messageShown;
    private boolean reloadOnResume;
    private String origin;
    private final Handler handler = new Handler(Looper.getMainLooper());
    // Images shared from another app (a screenshot from the gallery). They are
    // read here, held in memory, and each is handed to the page once through
    // an in-app URL that never reaches the network. Nothing is uploaded until
    // the user picks a destination on the page.
    private static final String SHARED_PREFIX = "/__ponte_shared/";
    private static final int MAX_SHARED_IMAGES = 10;
    private static final int MAX_SHARED_BYTES = 20 * 1024 * 1024;
    private static final int FILE_CHOOSER_REQUEST = 7201;
    private final Map<String, SharedImage> sharedImages = Collections.synchronizedMap(new LinkedHashMap<>());
    private ValueCallback<Uri[]> fileCallback;
    private static final class SharedImage {
        final String mime; final String name; final byte[] bytes;
        SharedImage(String mime, String name, byte[] bytes) { this.mime = mime; this.name = name; this.bytes = bytes; }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("ponte-pairing", MODE_PRIVATE);
        consumePairingIntent(getIntent());
        consumeShareIntent(getIntent());
        agentSession = getIntent() != null && getIntent().getBooleanExtra("ponte.agent", false);
        if (agentSession && android.os.Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        getWindow().setStatusBarColor(Color.rgb(21, 23, 20));
        getWindow().setNavigationBarColor(Color.rgb(21, 23, 20));
        // A remote control is watched, not touched, for minutes at a time: the
        // phone must not dim and lock in the middle of a stream.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(21, 23, 20));
        setContentView(root);
        try (InputStream certificate = getAssets().open("pc-ca.pem")) {
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
        consumeShareIntent(intent);
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
        // Only @JavascriptInterface methods are exposed on the supported API
        // levels. Every call still verifies the WebView's current loopback
        // origin before it can affect the Activity.
        browser.addJavascriptInterface(new PageBridge(), "PonteNative");
        CookieManager.getInstance().setAcceptCookie(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false);
        // Inspectable only in an explicitly debuggable dogfooding build.
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        browser.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) { loadFailed = false; }
            @Override public void onPageFinished(WebView view, String url) {
                if (!loadFailed) loadAttempts = 0;
                Uri address = Uri.parse(view.getUrl() == null ? url : view.getUrl());
                if (ownOrigin(address) && (address.getFragment() == null || !address.getFragment().startsWith("pair="))) {
                    // The web app consumed the fragment into its private DOM
                    // storage. Keep no native copy that could undo an unpair.
                    preferences.edit().remove("pair_token").putBoolean("intent_pairing_consumed", true).apply();
                }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri target = request.getUrl();
                // The page has no JavaScript bridge. Its closed ponte:// command
                // set can only rotate the Activity or raise the keyboard for a
                // DOM field that the trusted loopback page already focused.
                if (target != null && "ponte".equals(target.getScheme())) { handlePageCommand(target); return true; }
                return !ownOrigin(target);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse shared = sharedImageResponse(request);
                if (shared != null) return shared;
                return allowedResource(request.getUrl()) ? null : blockedResource();
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !paused && !destroyed) { loadFailed = true; showUnavailable(); }
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (!request.isForMainFrame() || error.getStatusCode() < 400 || paused || destroyed) return;
                loadFailed = true;
                if ("proxy_certificate".equals(error.getReasonPhrase())) showCertificateChanged(); else showUnavailable();
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
            // <input type=file> on the page: the system picker, images only.
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (destroyed || paused || !ownOrigin(Uri.parse(view.getUrl() == null ? "" : view.getUrl()))) return false;
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("image/*");
                pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/png", "image/jpeg", "image/webp"});
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(pick, FILE_CHOOSER_REQUEST); }
                catch (ActivityNotFoundException missing) { fileCallback = null; return false; }
                return true;
            }
        });
        root.addView(browser, new FrameLayout.LayoutParams(-1, -1));
    }

    private void handlePageCommand(Uri command) {
        if (destroyed || browser == null || !ownOrigin(Uri.parse(browser.getUrl() == null ? "" : browser.getUrl()))) return;
        String mode = command.getPath() == null ? "" : command.getPath().replace("/", "");
        if ("orientation".equals(command.getHost())) {
            if ("landscape".equals(mode)) {
                setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            } else if ("auto".equals(mode)) {
                setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            }
            return;
        }
        if (!paused && "keyboard".equals(command.getHost()) && "show".equals(mode)) {
            requestPhoneKeyboard();
        }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileCallback == null) return;
        ValueCallback<Uri[]> callback = fileCallback;
        fileCallback = null;
        Uri[] chosen = null;
        if (resultCode == RESULT_OK && data != null) {
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) for (int index = 0; index < data.getClipData().getItemCount() && uris.size() < MAX_SHARED_IMAGES; index++) uris.add(data.getClipData().getItemAt(index).getUri());
            else if (data.getData() != null) uris.add(data.getData());
            chosen = uris.isEmpty() ? null : uris.toArray(new Uri[0]);
        }
        callback.onReceiveValue(chosen);
    }
    private void consumeShareIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        List<Uri> uris = new ArrayList<>();
        try {
            if (Intent.ACTION_SEND.equals(action)) {
                Uri single = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (single != null) uris.add(single);
            } else {
                ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (many != null) uris.addAll(many);
            }
        } catch (RuntimeException invalid) { return; }
        // Consumed once: a recreated Activity must not offer the same images again.
        intent.setAction(Intent.ACTION_MAIN);
        intent.removeExtra(Intent.EXTRA_STREAM);
        if (uris.isEmpty()) return;
        final List<Uri> incoming = new ArrayList<>(uris.subList(0, Math.min(uris.size(), MAX_SHARED_IMAGES)));
        final ContentResolver resolver = getContentResolver();
        new Thread(() -> {
            Map<String, SharedImage> read = new LinkedHashMap<>();
            for (Uri uri : incoming) {
                SharedImage image = readSharedImage(resolver, uri);
                if (image != null) read.put(randomId(), image);
            }
            runOnUiThread(() -> {
                if (destroyed || read.isEmpty()) return;
                synchronized (sharedImages) { sharedImages.clear(); sharedImages.putAll(read); }
                if (browser != null && ownOrigin(Uri.parse(browser.getUrl() == null ? "" : browser.getUrl()))) {
                    browser.evaluateJavascript("window.dispatchEvent(new Event('ponte-native-shared')); true;", null);
                }
            });
        }, "ponte-share-read").start();
    }
    // Only content:// from another app. A file:// or our own provider could
    // point at this app's private files (the pairing key), so both are refused.
    private SharedImage readSharedImage(ContentResolver resolver, Uri uri) {
        if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null || uri.getAuthority().startsWith(getPackageName())) return null;
        String mime;
        try { mime = resolver.getType(uri); } catch (RuntimeException error) { return null; }
        if (!"image/png".equals(mime) && !"image/jpeg".equals(mime) && !"image/webp".equals(mime)) return null;
        String name = uri.getLastPathSegment();
        if (name == null || !name.matches("[A-Za-z0-9 ._()-]{1,80}")) name = "image";
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) return null;
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) > 0) {
                if (output.size() + count > MAX_SHARED_BYTES) return null;
                output.write(buffer, 0, count);
            }
            return output.size() == 0 ? null : new SharedImage(mime, name, output.toByteArray());
        } catch (IOException | RuntimeException error) { return null; }
    }
    private static String randomId() {
        byte[] bytes = new byte[12];
        new java.security.SecureRandom().nextBytes(bytes);
        StringBuilder id = new StringBuilder();
        for (byte value : bytes) id.append(String.format("%02x", value));
        return id.toString();
    }
    private WebResourceResponse sharedImageResponse(WebResourceRequest request) {
        Uri url = request.getUrl();
        if (!ownOrigin(url) || url.getPath() == null || !url.getPath().startsWith(SHARED_PREFIX)) return null;
        SharedImage image = "GET".equals(request.getMethod()) ? sharedImages.remove(url.getPath().substring(SHARED_PREFIX.length())) : null;
        if (image == null) return blockedResource();
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse(image.mime, null, 200, "OK", headers, new ByteArrayInputStream(image.bytes));
    }
    private final class PageBridge {
        // Metadata of the shared images still waiting; their bytes are fetched
        // once from SHARED_PREFIX + id and then dropped.
        @JavascriptInterface public String sharedImages() {
            StringBuilder json = new StringBuilder("[");
            synchronized (sharedImages) {
                for (Map.Entry<String, SharedImage> entry : sharedImages.entrySet()) {
                    if (json.length() > 1) json.append(',');
                    json.append("{\"id\":\"").append(entry.getKey()).append("\",\"mime\":\"").append(entry.getValue().mime)
                        .append("\",\"name\":\"").append(entry.getValue().name).append("\",\"bytes\":").append(entry.getValue().bytes.length).append('}');
                }
            }
            return json.append(']').toString();
        }
        @JavascriptInterface public void showKeyboard() {
            runOnUiThread(() -> requestPhoneKeyboard());
        }
        // The typing bar closed (PC field lost focus, connection dropped): the
        // IME must go with it, or keys land in a WebView with nothing focused.
        @JavascriptInterface public void hideKeyboard() {
            runOnUiThread(() -> hidePhoneKeyboard());
        }
    }
    private void hidePhoneKeyboard() {
        if (destroyed || browser == null) return;
        InputMethodManager keyboard = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(browser.getWindowToken(), 0);
    }
    private void requestPhoneKeyboard() {
        if (destroyed || paused || browser == null || !ownOrigin(Uri.parse(browser.getUrl() == null ? "" : browser.getUrl()))) return;
        browser.setFocusableInTouchMode(true);
        // Re-requesting focus on a WebView that already has it moves the page
        // focus away from the typing field; only ask when it is really missing.
        if (!browser.hasFocus()) browser.requestFocusFromTouch();
        browser.postDelayed(() -> showPhoneKeyboard(0), 40);
    }
    private void showPhoneKeyboard(int attempt) {
        if (destroyed || paused || browser == null || !ownOrigin(Uri.parse(browser.getUrl() == null ? "" : browser.getUrl()))) return;
        InputMethodManager keyboard = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (keyboard == null) return;
        keyboard.restartInput(browser);
        boolean shown = keyboard.showSoftInput(browser, InputMethodManager.SHOW_IMPLICIT);
        if (!shown && attempt == 0) browser.postDelayed(() -> showPhoneKeyboard(1), 140);
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
        messageShown = false;
        String token = preferences.getString("pair_token", "");
        String url = origin + "/";
        if (token.matches("[A-Za-z0-9_-]{32,128}")) url += "#pair=" + Uri.encode(token);
        browser.loadUrl(url);
        reloadOnResume = false;
    }
    private void showCertificateChanged() {
        runOnUiThread(() -> showMessage(nativeText("Your PC's certificate changed", "O certificado do seu PC mudou"),
            nativeText("This app was built for a previous certificate. On the PC, run ./android/build.sh and install the new Ponte.apk over this one.",
                       "Este app foi gerado para um certificado anterior. No PC, rode ./android/build.sh e instale o novo Ponte.apk por cima deste."), true));
    }
    private void showUnavailable() {
        if (++loadAttempts <= 3) {
            long delay = 1500L * loadAttempts;
            runOnUiThread(() -> {
                showMessage(nativeText("Connecting to your PC…", "Conectando ao seu PC…"), nativeText("Waiting for Tailscale.", "Aguardando o Tailscale."), false);
                // The WebView is detached while a message shows, so its own
                // postDelayed would only run once re-attached; use the Activity's.
                handler.postDelayed(() -> { if (!paused && !destroyed && loadFailed) loadHome(); }, delay);
            });
            return;
        }
        loadAttempts = 0;
        runOnUiThread(() -> showMessage(nativeText("Your PC has not responded", "Seu PC ainda não respondeu"), nativeText("Connect Tailscale on your phone and keep your PC awake. Then try again.", "Conecte o Tailscale no celular e mantenha o PC ligado. Depois, tente novamente."), true));
    }
    private String nativeText(String english, String portuguese) {
        return "pt".equals(preferences.getString("language", "en")) ? portuguese : english;
    }
    private void showMessage(String title, String detail, boolean retry) {
        if (destroyed) return;
        messageShown = true;
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
        if (agentSession && !destroyed && !isFinishing()) finish();
    }
    @Override protected void onResume() {
        super.onResume(); paused = false; ++pauseGeneration;
        microphonePermission.resume();
        if (proxy != null) proxy.setPaused(false);
        if (browser != null) {
            browser.onResume();
            // A load that failed while we were being paused (the keyguard
            // transition of an agent session, a permission dialog) is retried
            // on its own instead of waiting for a tap on "Try again".
            if (reloadOnResume || (loadFailed && messageShown)) loadHome();
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
        sharedImages.clear();
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        cancelMicrophonePermission();
        if (proxy != null) proxy.close();
        if (browser != null) { root.removeView(browser); browser.stopLoading(); browser.destroy(); browser = null; }
        super.onDestroy();
    }
}
