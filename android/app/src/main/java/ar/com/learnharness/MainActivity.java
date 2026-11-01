package ar.com.learnharness;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.webkit.CookieManager;
import android.widget.*;
import java.net.*;
import java.util.*;

public final class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<WebView> popups = new ArrayList<>();
    private WebView web;
    private LinearLayout loading;
    private TextView status;
    private ValueCallback<Uri[]> fileCallback;
    private boolean opened, destroyed;
    private long started;
    private static final int FILE_PICKER = 10;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(20, 25, 23));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return insets;
            });
        } else root.setFitsSystemWindows(true);
        web = new WebView(this);
        configure(web);
        web.setVisibility(View.INVISIBLE);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        loading = new LinearLayout(this);
        loading.setOrientation(LinearLayout.VERTICAL); loading.setGravity(Gravity.CENTER); loading.setPadding(40, 40, 40, 40);
        ProgressBar spinner = new ProgressBar(this); loading.addView(spinner);
        status = new TextView(this); status.setTextColor(Color.rgb(218, 233, 222)); status.setTextSize(18); status.setGravity(Gravity.CENTER);
        status.setText("Preparando LearnHarness…\nLa primera apertura puede tardar un minuto.");
        loading.addView(status, new LinearLayout.LayoutParams(-1, -2));
        root.addView(loading, new FrameLayout.LayoutParams(-1, -1));
        web.setWebViewClient(client(false));
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView source, boolean dialog, boolean gesture, Message result) {
                if (!gesture || popups.size() >= 3) return false;
                WebView popup = new WebView(MainActivity.this); configure(popup); popup.setWebViewClient(client(true));
                popup.setWebChromeClient(new WebChromeClient() {
                    @Override public void onCloseWindow(WebView window) { closePopup(window); }
                });
                popups.add(popup);
                ((WebView.WebViewTransport) result.obj).setWebView(popup); result.sendToTarget();
                return true;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                String[] types = Arrays.stream(params.getAcceptTypes()).filter(t -> t.contains("/")).toArray(String[]::new);
                if (types.length > 0) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(intent, FILE_PICKER); }
                catch (ActivityNotFoundException error) { callback.onReceiveValue(null); fileCallback = null; Toast.makeText(MainActivity.this, "No hay un selector de archivos disponible", Toast.LENGTH_LONG).show(); }
                return true;
            }
        });
        startForegroundService(new Intent(this, RuntimeService.class));
        started = System.currentTimeMillis();
        poll();
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void configure(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(true); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " LearnHarnessAndroid/1");
        settings.setLoadWithOverviewMode(true); settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
    }

    private boolean local(String url) {
        try { URI value = new URI(url), origin = new URI(RuntimeService.origin); return value.getRawUserInfo() == null && value.getScheme().equals(origin.getScheme()) && value.getHost().equals(origin.getHost()) && value.getPort() == origin.getPort(); }
        catch (Exception ignored) { return false; }
    }

    private WebViewClient client(boolean popup) {
        return new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.equals("about:blank")) return false;
                if (local(url)) {
                    if (popup && !request.getUrl().getPath().equals("/api/subscriptions/browser")) { web.loadUrl(url); closePopup(view); return true; }
                    return false;
                }
                String scheme = request.getUrl().getScheme();
                if (request.isForMainFrame() && (popup || request.hasGesture()) && ("https".equals(scheme) || "http".equals(scheme))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()).addCategory(Intent.CATEGORY_BROWSABLE)); }
                    catch (ActivityNotFoundException error) { Toast.makeText(MainActivity.this, "Instalá Chrome o Samsung Internet para iniciar sesión", Toast.LENGTH_LONG).show(); }
                }
                if (popup) closePopup(view);
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!popup && local(url)) { loading.setVisibility(View.GONE); web.setVisibility(View.VISIBLE); }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!popup && request.isForMainFrame()) showError("No se pudo abrir la app local. Cerrá LearnHarness desde aplicaciones recientes y volvé a abrirla. Tus datos quedan guardados.");
            }
        };
    }

    private void closePopup(WebView popup) { handler.post(() -> { if (popups.remove(popup)) popup.destroy(); }); }
    private void showError(String message) {
        loading.setVisibility(View.VISIBLE); web.setVisibility(View.INVISIBLE);
        loading.getChildAt(0).setVisibility(View.GONE); status.setText(message);
    }
    private void poll() {
        if (destroyed || opened) return;
        if (RuntimeService.failure != null) { showError(RuntimeService.failure); return; }
        if (System.currentTimeMillis() - started > 180000) { showError("El inicio tardó demasiado. Cerrá LearnHarness desde aplicaciones recientes y volvé a abrirla."); return; }
        String origin = RuntimeService.origin, secret = RuntimeService.secret;
        if (origin == null || secret == null) { handler.postDelayed(this::poll, 400); return; }
        new Thread(() -> {
            boolean ready = false;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(origin + "/api/subscriptions").openConnection();
                connection.setConnectTimeout(1500); connection.setReadTimeout(2000);
                connection.setRequestProperty("Cookie", "lh_android=" + secret);
                connection.setRequestProperty("x-learnharness-subscriptions", "1");
                ready = connection.getResponseCode() == 200;
            } catch (Exception ignored) { } finally { if (connection != null) connection.disconnect(); }
            final boolean result = ready;
            handler.post(() -> {
                if (destroyed) return;
                if (!result) { handler.postDelayed(this::poll, 500); return; }
                opened = true;
                CookieManager cookies = CookieManager.getInstance(); cookies.setAcceptCookie(true);
                cookies.setCookie(origin, "lh_android=" + secret + "; Path=/; HttpOnly; SameSite=Strict", success -> {
                    if (!destroyed && success) { cookies.flush(); web.loadUrl(origin); }
                    else if (!destroyed) showError("No se pudo habilitar el acceso privado de la app.");
                });
            });
        }, "LearnHarnessReady").start();
    }

    @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == FILE_PICKER && fileCallback != null) {
            List<Uri> selected = new ArrayList<>();
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) selected.add(data.getClipData().getItemAt(i).getUri());
                else if (data.getData() != null) selected.add(data.getData());
            }
            fileCallback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0])); fileCallback = null;
        }
    }
    @Override protected void onDestroy() {
        destroyed = true; handler.removeCallbacksAndMessages(null);
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        for (WebView popup : popups) popup.destroy(); popups.clear();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
