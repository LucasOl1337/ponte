package app.ponte.omarchy;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.*;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

/**
 * Alerts with the app closed. One long-poll to the PC's /api/agents/events
 * stays open, straight to the server with the app's pinned TLS (the loopback
 * proxy sleeps with the app). The PC answers when an agent starts waiting or
 * finishes, or after 50 s with nothing; either way the next request goes out
 * at once. No wakelock and no timer: with the screen off the connection just
 * sits there until the PC has something to say. Errors back off from 5 s to
 * 5 min, and without a network the loop waits for one.
 */
public final class AgentAlertService extends Service {
    static final String PREFS = "ponte-pairing";
    /** "on" or "off"; absent until the page first reports the switch. */
    static final String PREF_STATE = "agent_alerts";
    /** The page's pairing key, handed over by the page for this service only. */
    static final String PREF_TOKEN = "agent_alerts_token";
    static final String ACTION_OFF = "app.ponte.omarchy.AGENT_ALERTS_OFF";
    static final String ACTION_OPEN_AGENT = "app.ponte.omarchy.OPEN_AGENT";
    static final String EXTRA_AGENT = "ponte.open_agent";
    private static final String CHANNEL_WATCH = "ponte_agent_watch";
    private static final String CHANNEL_ALERTS = "ponte_agent_alerts";
    private static final int WATCH_ID = 1;
    private static final int ALERT_ID = 2;

    private final Object lock = new Object();
    private final Handler main = new Handler(Looper.getMainLooper());
    private SharedPreferences preferences;
    private PinnedTls tls;
    private Thread worker;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;
    private Network defaultNetwork;
    private volatile boolean running;
    private volatile boolean online;
    private volatile HttpsURLConnection current;

    static boolean notificationsAllowed(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        return manager != null && manager.areNotificationsEnabled();
    }
    static void start(Context context) { context.startForegroundService(new Intent(context, AgentAlertService.class)); }
    static void stop(Context context) { context.stopService(new Intent(context, AgentAlertService.class)); }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_OFF.equals(intent.getAction())) {
            // "Turn off" on the notification is the same switch as the page's:
            // the page reads this choice on its next load.
            preferences.edit().putString(PREF_STATE, "off").remove(PREF_TOKEN).apply();
            shutdown();
            return START_NOT_STICKY;
        }
        boolean pt = portuguese();
        createChannels(pt);
        try { goForeground(pt); }
        catch (RuntimeException notAllowed) { shutdown(); return START_NOT_STICKY; }
        if (!"on".equals(preferences.getString(PREF_STATE, "")) || !AgentAlerts.validToken(preferences.getString(PREF_TOKEN, "")) || !notificationsAllowed(this)) {
            shutdown();
            return START_NOT_STICKY;
        }
        if (!running) begin();
        return START_STICKY;
    }

    private boolean portuguese() { return AgentAlerts.portuguese(preferences.getString("language", "en")); }

    private void createChannels(boolean pt) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel watch = new NotificationChannel(CHANNEL_WATCH, AgentAlerts.watchChannel(pt), NotificationManager.IMPORTANCE_LOW);
        watch.setShowBadge(false);
        NotificationChannel alerts = new NotificationChannel(CHANNEL_ALERTS, AgentAlerts.alertChannel(pt), NotificationManager.IMPORTANCE_HIGH);
        alerts.enableVibration(true);
        manager.createNotificationChannel(watch);
        manager.createNotificationChannel(alerts);
    }

    private void goForeground(boolean pt) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent off = PendingIntent.getService(this, 1, new Intent(this, AgentAlertService.class).setAction(ACTION_OFF),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL_WATCH)
            .setSmallIcon(R.drawable.ic_stat_ponte)
            .setContentTitle(AgentAlerts.watchingTitle(pt))
            .setContentText(AgentAlerts.watchingText(pt))
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .addAction(new Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stat_ponte), AgentAlerts.turnOff(pt), off).build())
            .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(WATCH_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(WATCH_ID, notification);
    }

    private void begin() {
        try (InputStream certificate = getAssets().open("pc-ca.pem")) { tls = new PinnedTls(certificate); }
        catch (Exception unusable) { shutdown(); return; }
        running = true;
        connectivity = getSystemService(ConnectivityManager.class);
        online = connectivity != null && connectivity.getActiveNetwork() != null;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                boolean switched;
                synchronized (lock) { switched = defaultNetwork != null && !defaultNetwork.equals(network); defaultNetwork = network; online = true; lock.notifyAll(); }
                // A request held on the previous network would only time out.
                if (switched) abortCurrent();
            }
            @Override public void onLost(Network network) {
                synchronized (lock) { if (defaultNetwork != null && !defaultNetwork.equals(network)) return; defaultNetwork = null; online = false; }
                abortCurrent();
            }
        };
        try { if (connectivity != null) connectivity.registerDefaultNetworkCallback(networkCallback); }
        catch (RuntimeException tooManyCallbacks) { networkCallback = null; online = true; }
        worker = new Thread(this::loop, "ponte-agent-alerts");
        worker.start();
    }

    private void loop() {
        long after = -1;
        int failures = 0;
        while (running) {
            synchronized (lock) {
                try { while (running && !online) lock.wait(); }
                catch (InterruptedException stopping) { return; }
            }
            if (!running) return;
            String token = preferences.getString(PREF_TOKEN, "");
            if (!AgentAlerts.validToken(token)) { main.post(this::shutdown); return; }
            try {
                AgentAlerts.Batch batch = poll(after, token);
                failures = 0;
                // The first answer, and one from a restarted PC, is only a baseline.
                if (after >= 0 && batch.seq >= after) for (AgentAlerts.Event event : batch.events) if (event.seq > after) alert(event);
                after = batch.seq;
            } catch (Unauthorized revoked) {
                // The PC no longer accepts this key. The switch stays on; the page
                // hands over its fresh key on its next load.
                preferences.edit().remove(PREF_TOKEN).apply();
                main.post(this::shutdown);
                return;
            } catch (Exception error) {
                if (!running) return;
                failures++;
                synchronized (lock) {
                    // A network coming back ends the wait early.
                    try { if (running) lock.wait(AgentAlerts.backoffMs(failures)); }
                    catch (InterruptedException stopping) { return; }
                }
            }
        }
    }

    private static final class Unauthorized extends IOException {}

    private AgentAlerts.Batch poll(long after, String token) throws IOException {
        URL url = new URL(BuildConfig.UPSTREAM.replaceAll("/$", "") + AgentAlerts.eventsPath(after));
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        connection.setSSLSocketFactory(tls.socketFactory());
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout((AgentAlerts.WAIT_SECONDS + 20) * 1000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Accept-Encoding", "identity");
        current = connection;
        boolean reusable = false;
        try {
            if (!running) throw new IOException("stopped");
            connection.connect();
            tls.requirePinnedPeer(connection);
            int status = connection.getResponseCode();
            if (status == 401) throw new Unauthorized();
            if (status != 200) throw new IOException("HTTP " + status);
            AgentAlerts.Batch batch;
            try (InputStream input = connection.getInputStream()) { batch = AgentAlerts.parse(readBounded(input)); }
            catch (IllegalArgumentException malformed) { throw new IOException("Unexpected answer", malformed); }
            // Read to the end: the kept-alive connection carries the next poll
            // without a new TLS handshake.
            reusable = true;
            return batch;
        } finally {
            current = null;
            if (!reusable) connection.disconnect();
        }
    }

    private static String readBounded(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
            bytes.write(buffer, 0, count);
            if (bytes.size() > AgentAlerts.MAX_BODY) throw new IOException("Answer too large");
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }

    /** Only while Ponte is not on screen: in front, the page's own notice shows it. */
    private void alert(AgentAlerts.Event event) {
        ActivityManager.RunningAppProcessInfo process = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(process);
        if (process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || !notificationsAllowed(this)) return;
        boolean pt = portuguese();
        Intent open = new Intent(this, MainActivity.class).setAction(ACTION_OPEN_AGENT).putExtra(EXTRA_AGENT, event.id)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, event.id.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification locked = new Notification.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_ponte)
            .setContentTitle(AgentAlerts.lockedTitle(event, pt))
            .build();
        Notification notification = new Notification.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_ponte)
            .setContentTitle(AgentAlerts.title(event, pt))
            .setContentText(AgentAlerts.detail(event, pt))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(locked)
            .setAutoCancel(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
            .setContentIntent(tap)
            .build();
        // One alert per agent: the tag is its id, so a newer one replaces it.
        manager.notify(event.id, ALERT_ID, notification);
    }

    private void abortCurrent() {
        final HttpsURLConnection connection = current;
        if (connection == null) return;
        // Closing TLS may block; never on the main thread.
        new Thread(connection::disconnect, "ponte-agent-alerts-abort").start();
    }

    private void shutdown() {
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onDestroy() {
        running = false;
        synchronized (lock) { lock.notifyAll(); }
        if (worker != null) worker.interrupt();
        abortCurrent();
        if (networkCallback != null && connectivity != null) {
            try { connectivity.unregisterNetworkCallback(networkCallback); } catch (RuntimeException alreadyGone) { }
            networkCallback = null;
        }
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
