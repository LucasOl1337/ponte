package app.ponte.omarchy;

import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import javax.net.ssl.*;

public final class ProxyTest {
    static int checks;
    static void check(boolean condition, String description) { if (!condition) throw new AssertionError(description); checks++; }
    static final class Remote implements AutoCloseable {
        final HttpsServer server;
        final AtomicInteger hits = new AtomicInteger();
        final AtomicReference<String> auth = new AtomicReference<>();
        final AtomicReference<String> origin = new AtomicReference<>();
        final AtomicReference<String> referer = new AtomicReference<>();
        final AtomicReference<String> language = new AtomicReference<>();
        final AtomicReference<byte[]> body = new AtomicReference<>();
        final AtomicBoolean redirect = new AtomicBoolean();
        final CountDownLatch streamOpened = new CountDownLatch(1);
        final CountDownLatch releaseStream = new CountDownLatch(1);
        final ExecutorService workers = Executors.newCachedThreadPool(r -> { Thread t = new Thread(r); t.setDaemon(true); return t; });
        Remote(Path store) throws Exception {
            KeyStore keys = KeyStore.getInstance("PKCS12");
            try (InputStream input = Files.newInputStream(store)) { keys.load(input, "test-only".toCharArray()); }
            KeyManagerFactory km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()); km.init(keys, "test-only".toCharArray());
            SSLContext tls = SSLContext.getInstance("TLS"); tls.init(km.getKeyManagers(), null, null);
            server = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 8);
            server.setHttpsConfigurator(new HttpsConfigurator(tls)); server.setExecutor(workers);
            server.createContext("/", exchange -> {
                hits.incrementAndGet(); auth.set(exchange.getRequestHeaders().getFirst("Authorization"));
                origin.set(exchange.getRequestHeaders().getFirst("Origin")); referer.set(exchange.getRequestHeaders().getFirst("Referer"));
                language.set(exchange.getRequestHeaders().getFirst("Accept-Language"));
                body.set(exchange.getRequestBody().readAllBytes());
                if (redirect.get()) { exchange.getResponseHeaders().set("Location", "/api/audio"); exchange.sendResponseHeaders(302, -1); exchange.close(); return; }
                if (exchange.getRequestURI().getPath().equals("/api/stream")) {
                    exchange.getResponseHeaders().set("Content-Type", "multipart/x-mixed-replace; boundary=ponte-frame");
                    exchange.sendResponseHeaders(200, 0);
                    try (OutputStream output = exchange.getResponseBody()) {
                        output.write("first-frame".getBytes(StandardCharsets.UTF_8)); output.flush(); streamOpened.countDown();
                        try { releaseStream.await(5, TimeUnit.SECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                        output.write("next-frame".getBytes(StandardCharsets.UTF_8)); output.flush();
                    } catch (IOException expectedOnCancel) { }
                    return;
                }
                byte[] bytes = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json"); exchange.sendResponseHeaders(200, bytes.length);
                try (OutputStream output = exchange.getResponseBody()) { output.write(bytes); }
            });
            server.start();
        }
        URI uri(String host) { return URI.create("https://" + host + ":" + server.getAddress().getPort()); }
        public void close() { releaseStream.countDown(); server.stop(0); workers.shutdownNow(); }
    }

    static String raw(LoopbackProxy proxy, String request) throws Exception {
        URI origin = URI.create(proxy.origin());
        try (Socket socket = new Socket("127.0.0.1", origin.getPort())) {
            socket.setSoTimeout(5000);
            socket.getOutputStream().write(request.getBytes(StandardCharsets.ISO_8859_1));
            socket.getOutputStream().flush();
            return new String(socket.getInputStream().readAllBytes(), StandardCharsets.ISO_8859_1);
        }
    }
    static String request(LoopbackProxy proxy, String method, String target, String headers) {
        return method + " " + target + " HTTP/1.1\r\nHost: " + URI.create(proxy.origin()).getAuthority() + "\r\n" + headers + "\r\n";
    }
    static LoopbackProxy proxy(Remote remote, Path cert, String host) throws Exception {
        try (InputStream input = Files.newInputStream(cert)) { return new LoopbackProxy(remote.uri(host), input, 0); }
    }
    public static void main(String[] args) throws Exception {
        Path fixtures = Paths.get(args[0]);
        try (Remote remote = new Remote(fixtures.resolve("good.p12")); LoopbackProxy proxy = proxy(remote, fixtures.resolve("good.crt"), "127.0.0.1")) {
            check(proxy.isLoopbackBound(), "listener must bind loopback only");
            String response = raw(proxy, request(proxy, "GET", "/api/state", ""));
            check(response.startsWith("HTTP/1.1 200"), "trusted TLS forwards GET");
            check(remote.auth.get() == null, "proxy must never inject an auth token");
            response = raw(proxy, request(proxy, "GET", "/api/state", "Authorization: Bearer test-only\r\nOrigin: " + proxy.origin() + "\r\nReferer: " + proxy.origin() + "/\r\n"));
            check(response.startsWith("HTTP/1.1 200"), "same-origin request accepted");
            check("Bearer test-only".equals(remote.auth.get()), "bearer preserved exactly");
            check(remote.origin.get() == null && remote.referer.get() == null, "local Origin and Referer removed upstream");
            check(raw(proxy, request(proxy, "GET", "/api/state", "Origin: https://evil.example\r\n")).startsWith("HTTP/1.1 403"), "foreign Origin denied");
            check(raw(proxy, "GET /api/state HTTP/1.1\r\nHost: evil.example\r\n\r\n").startsWith("HTTP/1.1 403"), "foreign Host denied");
            check(raw(proxy, request(proxy, "GET", "https://evil.example/", "")).startsWith("HTTP/1.1 400"), "absolute URL denied");
            check(raw(proxy, request(proxy, "GET", "/../secret", "")).startsWith("HTTP/1.1 404"), "unlisted path denied");
            check(raw(proxy, request(proxy, "GET", "/%2e%2e/secret", "")).startsWith("HTTP/1.1 400"), "encoded path denied");
            check(raw(proxy, request(proxy, "DELETE", "/api/audio", "")).startsWith("HTTP/1.1 404"), "unlisted method denied");
            check(raw(proxy, request(proxy, "POST", "/api/audio", "Content-Length: 27262977\r\n")).startsWith("HTTP/1.1 413"), "body limit enforced before reading");
            check(raw(proxy, request(proxy, "POST", "/api/audio", "Transfer-Encoding: chunked\r\n")).startsWith("HTTP/1.1 400"), "request smuggling TE denied");
            check(raw(proxy, request(proxy, "POST", "/api/audio", "Content-Length: 1\r\nContent-Length: 2\r\n")).startsWith("HTTP/1.1 400"), "duplicate framing denied");
            check(raw(proxy, request(proxy, "GET", "/api/state", "X-Large: " + "a".repeat(17000) + "\r\n")).startsWith("HTTP/1.1 431"), "header cap enforced");
            HttpURLConnection upload = (HttpURLConnection) new URL(proxy.origin() + "/api/audio").openConnection();
            byte[] audio = new byte[256 * 1024]; new Random(4).nextBytes(audio);
            upload.setRequestMethod("POST"); upload.setDoOutput(true); upload.setFixedLengthStreamingMode(audio.length);
            upload.setRequestProperty("Content-Type", "audio/webm"); upload.setReadTimeout(5000);
            try (OutputStream output = upload.getOutputStream()) { output.write(audio); }
            check(upload.getResponseCode() == 200 && Arrays.equals(audio, remote.body.get()), "audio bytes stream unchanged"); upload.disconnect();
            remote.redirect.set(true); int before = remote.hits.get();
            check(raw(proxy, request(proxy, "GET", "/api/state", "")).startsWith("HTTP/1.1 502"), "redirect rejected");
            check(remote.hits.get() == before + 1, "redirect target never requested");
            String englishError = raw(proxy, request(proxy, "GET", "/api/state", ""));
            check(englishError.contains("The PC tried to redirect") && englishError.contains("proxy_redirect"), "native errors default to English with a stable code");
            String portugueseError = raw(proxy, request(proxy, "GET", "/api/state", "Accept-Language: pt-BR\r\n"));
            check(portugueseError.contains("O PC tentou redirecionar") && portugueseError.contains("proxy_redirect"), "native errors follow explicit Portuguese preference");
            check("pt-BR".equals(remote.language.get()), "language preference reaches the server unchanged");
            remote.redirect.set(false);
            check(raw(proxy, request(proxy, "GET", "/i18n.js", "")).startsWith("HTTP/1.1 200"), "translation module can load through native transport");
            HttpURLConnection live = (HttpURLConnection) new URL(proxy.origin() + "/api/stream?monitor=DP-1").openConnection(); live.setReadTimeout(3000);
            try (InputStream input = live.getInputStream()) {
                check(remote.streamOpened.await(2, TimeUnit.SECONDS), "upstream stream opened");
                check(input.read() == 'f', "first live byte arrives before upstream completes");
                long pauseAt = System.nanoTime();
                proxy.setPaused(true);
                check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - pauseAt) < 200, "pause must not block UI while upstream waits five seconds");
                // Resume immediately: old requests must remain canceled.
                proxy.setPaused(false);
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
                while (proxy.activeRequests() != 0 && System.nanoTime() < deadline) Thread.sleep(5);
                check(proxy.activeRequests() == 0, "pause interrupts upstream TLS read without waiting for next frame");
                boolean ended = false;
                try { while (input.read() != -1) { } ended = true; } catch (IOException canceled) { ended = true; }
                check(ended, "pause cancels active downstream stream");
            }
            live.disconnect(); proxy.setPaused(false);
            check(raw(proxy, request(proxy, "GET", "/api/state", "")).startsWith("HTTP/1.1 200"), "proxy resumes after pause");
        }
        try (Remote remote = new Remote(fixtures.resolve("good.p12")); LoopbackProxy proxy = proxy(remote, fixtures.resolve("good.crt"), "127.0.0.1")) {
            HttpURLConnection live = (HttpURLConnection) new URL(proxy.origin() + "/api/stream").openConnection(); live.setReadTimeout(3000);
            try (InputStream input = live.getInputStream()) {
                check(input.read() == 'f', "destroy test starts an active TLS stream");
                long closeAt = System.nanoTime();
                proxy.close();
                check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - closeAt) < 200, "Activity destroy must not block on TLS cleanup");
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
                while (proxy.activeRequests() != 0 && System.nanoTime() < deadline) Thread.sleep(5);
                check(proxy.activeRequests() == 0, "destroy interrupts upstream TLS reader");
            } finally { live.disconnect(); }
        }
        try (Remote remote = new Remote(fixtures.resolve("good.p12")); LoopbackProxy proxy = proxy(remote, fixtures.resolve("good.crt"), "127.0.0.1")) {
            proxy.setPaused(true);
            try (Socket incomplete = new Socket("127.0.0.1", URI.create(proxy.origin()).getPort())) {
                incomplete.setSoTimeout(1000);
                incomplete.getOutputStream().write("GET /api/state HTTP/1.1\r\n".getBytes(StandardCharsets.US_ASCII));
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
                while (proxy.activeRequests() == 0 && System.nanoTime() < deadline) Thread.sleep(5);
                check(proxy.activeRequests() == 1, "incomplete request is tracked while paused");
                proxy.close();
                boolean ended = false;
                try { ended = incomplete.getInputStream().read() == -1; } catch (SocketException canceled) { ended = true; }
                check(ended, "destroy closes a request that arrived while already paused");
                check(remote.hits.get() == 0, "paused incomplete request never reaches PC");
            }
        }
        try (Remote remote = new Remote(fixtures.resolve("good.p12")); LoopbackProxy proxy = proxy(remote, fixtures.resolve("good.crt"), "localhost")) {
            check(raw(proxy, request(proxy, "GET", "/api/state", "Authorization: Bearer must-not-reach\r\n")).startsWith("HTTP/1.1 502"), "hostname mismatch rejected");
            check(remote.hits.get() == 0, "no HTTP headers sent after hostname failure");
        }
        try (Remote remote = new Remote(fixtures.resolve("child.p12")); LoopbackProxy proxy = proxy(remote, fixtures.resolve("child.crt"), "127.0.0.1")) {
            check(raw(proxy, request(proxy, "GET", "/api/state", "Authorization: Bearer test-only\r\n")).startsWith("HTTP/1.1 200"), "CA-issued leaf is accepted when that exact leaf is pinned");
            check("Bearer test-only".equals(remote.auth.get()), "matching CA-issued leaf can receive Authorization");
        }
        for (String store : new String[]{"wrong.p12", "child.p12"}) {
            try (Remote remote = new Remote(fixtures.resolve(store)); LoopbackProxy proxy = proxy(remote, fixtures.resolve("good.crt"), "127.0.0.1")) {
                check(raw(proxy, request(proxy, "GET", "/api/state", "Authorization: Bearer must-not-reach\r\n")).startsWith("HTTP/1.1 502"), "untrusted or unpinned certificate rejected: " + store);
                check(remote.hits.get() == 0, "pin rejects before sending Authorization: " + store);
            }
        }
        try (ServerSocket occupied = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")); InputStream certificate = Files.newInputStream(fixtures.resolve("good.crt"))) {
            boolean rejected = false;
            try { new LoopbackProxy(URI.create("https://127.0.0.1:443"), certificate, occupied.getLocalPort()); }
            catch (BindException expected) { rejected = true; }
            check(rejected, "occupied local port must fail without fallback");
        }
        System.out.println("Native proxy: " + checks + " checks passed.");
    }
}
