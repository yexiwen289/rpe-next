package com.vibephi.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * VibePhi 移动端壳：全屏 WebView 通过虚拟 https 域加载 assets/www，
 * 保证 ES modules / localStorage / fetch 在安全上下文可用。
 */
public class MainActivity extends Activity {
    private static final String APP_HOST = "appassets.vibephi.local";
    private static final String START_URL = "https://" + APP_HOST + "/index.html";
    private static final int REQ_FILE_CHOOSER = 1001;

    /** 拦截网页 <a download> 的 blob 下载，转交原生桥保存到系统下载目录。 */
    private static final String BLOB_PATCH =
        "(function(){if(window.__vibephiBlobPatched)return;window.__vibephiBlobPatched=1;" +
        "document.addEventListener('click',function(e){" +
        "var t=e.target;var a=t&&t.closest?t.closest('a[download]'):null;" +
        "if(!a||!a.href||a.href.indexOf('blob:')!==0)return;" +
        "e.preventDefault();e.stopPropagation();" +
        "fetch(a.href).then(function(r){return r.blob()}).then(function(b){" +
        "var fr=new FileReader();" +
        "fr.onload=function(){try{VibePhiNative.saveFile(a.download||'vibephi-export.bin',fr.result.split(',')[1])}catch(err){}};" +
        "fr.readAsDataURL(b);});},true);})();";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        WebSettings st = web.getSettings();
        st.setJavaScriptEnabled(true);
        st.setDomStorageEnabled(true);
        st.setDatabaseEnabled(true);
        st.setTextZoom(100);
        st.setMediaPlaybackRequiresUserGesture(false);
        st.setAllowFileAccess(false);
        st.setAllowContentAccess(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!APP_HOST.equals(url.getHost())) return super.shouldInterceptRequest(view, request);
                String path = url.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                String asset = "www/" + path.substring(1);
                try {
                    InputStream in = getAssets().open(asset);
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Access-Control-Allow-Origin", "*");
                    headers.put("Cache-Control", "no-cache");
                    WebResourceResponse resp = new WebResourceResponse(guessMime(asset), null, in);
                    resp.setResponseHeaders(headers);
                    return resp;
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                            null, new ByteArrayInputStream("Not Found".getBytes(StandardCharsets.UTF_8)));
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (APP_HOST.equals(url.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(BLOB_PATCH, null);
                super.onPageFinished(view, url);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        // 兜底：非 blob 的 http(s) 下载交给系统下载器（blob 下载由 JS 桥处理）
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            try {
                if (url.startsWith("blob:") || url.startsWith("data:")) return;
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                String name = guessName(contentDisposition, url);
                req.setTitle(name);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm != null) dm.enqueue(req);
            } catch (Exception ignored) {
            }
        });

        web.addJavascriptInterface(new Bridge(), "VibePhiNative");
        setContentView(web);
        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(START_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    ClipData clip = data.getClipData();
                    int n = clip.getItemCount();
                    if (n > 0) {
                        result = new Uri[n];
                        for (int i = 0; i < n; i++) result[i] = clip.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null) {
            if (web.canGoBack()) {
                web.goBack();
            } else {
                moveTaskToBack(true);
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private static String guessMime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".mjs") || n.endsWith(".js")) return "text/javascript";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".ico")) return "image/x-icon";
        if (n.endsWith(".wav")) return "audio/wav";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".ogg")) return "audio/ogg";
        if (n.endsWith(".md")) return "text/markdown";
        if (n.endsWith(".woff2")) return "font/woff2";
        if (n.endsWith(".txt")) return "text/plain";
        String ext = MimeTypeMap.getFileExtensionFromUrl(name);
        String mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return mime == null ? "application/octet-stream" : mime;
    }

    private static String guessName(String contentDisposition, String url) {
        if (contentDisposition != null) {
            java.util.regex.Matcher m =
                    java.util.regex.Pattern.compile("filename\\*?=\"?([^\";]+)\"?").matcher(contentDisposition);
            if (m.find()) return m.group(1);
        }
        String path = Uri.parse(url).getLastPathSegment();
        return path == null || path.isEmpty() ? "vibephi-download" : path;
    }

    /** JS 桥：接收网页端 blob 下载（谱面导出/体检报告/资源包），写入系统下载目录。 */
    private class Bridge {
        @JavascriptInterface
        public boolean saveFile(String name, String base64) {
            try {
                if (name == null || name.isEmpty()) name = "vibephi-export.bin";
                name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, guessMime(name));
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IllegalStateException("insert failed");
                try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                    if (os == null) throw new IllegalStateException("stream null");
                    os.write(data);
                }
                toast("已保存到下载目录: " + name);
                return true;
            } catch (Exception e) {
                toast("保存失败: " + e.getMessage());
                return false;
            }
        }

        @JavascriptInterface
        public void toast(String msg) {
            if (msg == null) return;
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }
    }

    private void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }
}
