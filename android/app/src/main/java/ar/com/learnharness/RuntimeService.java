package ar.com.learnharness;

import android.app.*;
import android.content.*;
import android.os.*;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

public final class RuntimeService extends Service {
    static volatile String origin, secret, failure;
    private static boolean started;
    private static native int startNode(String script, String config, String cache);

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("runtime", "LearnHarness en la tablet", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        startForeground(1, new Notification.Builder(this, "runtime")
            .setSmallIcon(ar.com.learnharness.R.drawable.ic_launcher).setContentTitle("LearnHarness")
            .setContentText("Tus cursos se ejecutan en esta tablet").setContentIntent(open).setOngoing(true).build());
        synchronized (RuntimeService.class) {
            if (started) return;
            started = true;
        }
        new Thread(() -> {
            try {
                JSONObject metadata;
                try (InputStream in = getAssets().open("bundle.json")) { ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count; while ((count = in.read(buffer)) != -1) bytes.write(buffer, 0, count); metadata = new JSONObject(bytes.toString("UTF-8")); }
                File privateDir = new File(getNoBackupFilesDir(), "learnharness");
                if (!privateDir.isDirectory() && !privateDir.mkdirs()) throw new IOException("No hay espacio para guardar la app");
                File bundle = PayloadInstaller.install(getAssets().open("server.zip"), new File(privateDir, "bundles"), metadata.getString("sha256"));
                int port;
                try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) { port = socket.getLocalPort(); }
                byte[] random = new byte[32]; new SecureRandom().nextBytes(random);
                StringBuilder token = new StringBuilder(); for (byte b : random) token.append(String.format("%02x", b & 255));
                secret = token.toString();
                JSONObject settings = new JSONObject().put("port", port).put("secret", secret).put("directory", privateDir.getAbsolutePath());
                File config = new File(privateDir, "launch.json");
                try (FileOutputStream out = new FileOutputStream(config)) { out.write(settings.toString().getBytes(StandardCharsets.UTF_8)); }
                System.loadLibrary("node"); System.loadLibrary("learnharness");
                origin = "http://127.0.0.1:" + port;
                int code = startNode(new File(bundle, "bootstrap.cjs").getAbsolutePath(), config.getAbsolutePath(), getCacheDir().getAbsolutePath());
                failure = "El motor local se cerró (" + code + "). Cerrá la app desde aplicaciones recientes y volvé a abrirla.";
            } catch (Throwable error) {
                android.util.Log.e("LearnHarness", "Local runtime startup failed", error);
                failure = "No se pudo iniciar LearnHarness: " + error.getClass().getSimpleName() + ". Cerrá y volvé a abrir la app.";
            }
        }, "LearnHarnessRuntime").start();
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_NOT_STICKY; }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onTaskRemoved(Intent rootIntent) { stopSelf(); android.os.Process.killProcess(android.os.Process.myPid()); }
    @Override public void onTimeout(int startId, int fgsType) { stopSelf(); android.os.Process.killProcess(android.os.Process.myPid()); }
}
