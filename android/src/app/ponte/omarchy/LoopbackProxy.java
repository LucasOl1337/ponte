package app.ponte.omarchy;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import javax.net.ssl.*;

/** A bounded HTTP loopback adapter to one certificate-pinned HTTPS origin. */
public final class LoopbackProxy implements Closeable {
    public static final int MAX_HEADERS = 16 * 1024;
    public static final long MAX_BODY = 26L * 1024 * 1024;
    private static final Set<String> STATIC_PATHS = new HashSet<>(Arrays.asList(
        "/", "/index.html", "/app.js", "/i18n.js", "/styles.css", "/sw.js", "/manifest.webmanifest",
        "/icon.svg", "/icon-192.png", "/icon-512.png", "/progress.html", "/progress.js", "/progress.json"));
    private static final Set<String> FORWARD_HEADERS = new HashSet<>(Arrays.asList(
        "authorization", "content-type", "accept", "accept-language", "range"));
    private static final Set<String> RESPONSE_HEADERS = new HashSet<>(Arrays.asList(
        "content-type", "cache-control", "content-security-policy", "x-content-type-options",
        "referrer-policy", "permissions-policy", "service-worker-allowed", "x-live-max-fps",
        "content-range", "accept-ranges"));

    private final URI upstream;
    private final SSLSocketFactory tls;
    private final byte[] pinnedCertificate;
    private final ServerSocket server;
    private final String origin;
    private final String host;
    private final Set<Exchange> exchanges = ConcurrentHashMap.newKeySet();
    private final AtomicLong lifecycle = new AtomicLong();
    private final ExecutorService cancellations = new ThreadPoolExecutor(0, 8, 30, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(16), runnable -> { Thread t = new Thread(runnable, "ponte-proxy-cancel"); t.setDaemon(true); return t; });
    private final ExecutorService workers = new ThreadPoolExecutor(0, 8, 30, TimeUnit.SECONDS,
        new SynchronousQueue<>(), runnable -> { Thread t = new Thread(runnable, "ponte-proxy-request"); t.setDaemon(true); return t; });
    private volatile boolean closed;
    private volatile boolean paused;

    public LoopbackProxy(URI upstream, InputStream certificatePem, int port) throws Exception {
        if (!"https".equals(upstream.getScheme()) || upstream.getHost() == null || upstream.getUserInfo() != null
                || upstream.getQuery() != null || upstream.getFragment() != null
                || !(upstream.getPath().isEmpty() || upstream.getPath().equals("/"))) {
            throw new IllegalArgumentException("An HTTPS origin is required");
        }
        this.upstream = upstream;
        X509Certificate certificate = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(certificatePem);
        certificate.checkValidity();
        pinnedCertificate = certificate.getEncoded();
        KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
        store.load(null, null);
        store.setCertificateEntry("ponte-pc", certificate);
        TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trust.init(store);
        X509TrustManager delegate = null;
        for (TrustManager manager : trust.getTrustManagers()) if (manager instanceof X509TrustManager) delegate = (X509TrustManager) manager;
        if (delegate == null) throw new GeneralSecurityException("No X509 trust manager");
        final X509TrustManager trusted = delegate;
        X509TrustManager pinnedTrust = new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return trusted.getAcceptedIssuers(); }
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException { trusted.checkClientTrusted(chain, authType); }
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                trusted.checkServerTrusted(chain, authType);
                if (chain.length == 0 || !MessageDigest.isEqual(chain[0].getEncoded(), pinnedCertificate)) throw new CertificateException("Certificate pin mismatch");
                chain[0].checkValidity();
            }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{pinnedTrust}, new SecureRandom());
        tls = context.getSocketFactory();
        server = new ServerSocket();
        server.setReuseAddress(false);
        try { server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 12); }
        catch (IOException error) { closeQuietly(server); throw error; }
        host = "127.0.0.1:" + server.getLocalPort();
        origin = "http://" + host;
        Thread acceptor = new Thread(this::accept, "ponte-proxy-listener");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    public String origin() { return origin; }
    public boolean isLoopbackBound() { return server.getInetAddress().isLoopbackAddress(); }

    private void accept() {
        while (!closed) {
            try {
                Socket socket = server.accept();
                socket.setSoTimeout(15000);
                socket.setTcpNoDelay(true);
                Exchange exchange = new Exchange(socket);
                exchanges.add(exchange);
                try { workers.execute(() -> serve(exchange)); }
                catch (RejectedExecutionException full) { exchanges.remove(exchange); closeQuietly(socket); }
            } catch (IOException error) { if (!closed) closeQuietly(server); break; }
        }
    }

    private void serve(Exchange exchange) {
        Socket socket = exchange.local;
        HttpsURLConnection remote = null;
        boolean responseStarted = false;
        String language = "en";
        try {
            Socket local = socket;
            InputStream input = new BufferedInputStream(local.getInputStream(), 16384);
            OutputStream output = new BufferedOutputStream(local.getOutputStream(), 16384);
            Request request = Request.read(input, host, origin);
            language = request.headers.getOrDefault("accept-language", "en");
            exchange.requireActive();
            remote = (HttpsURLConnection) new URL(upstream.toString().replaceAll("/$", "") + request.target).openConnection();
            remote.setSSLSocketFactory(new TrackedTlsFactory(exchange));
            // Keep the platform's hostname verifier. The dedicated trust store
            // and the exact peer-certificate check are additional restrictions.
            remote.setInstanceFollowRedirects(false);
            remote.setConnectTimeout(8000);
            remote.setReadTimeout(15000);
            remote.setUseCaches(false);
            remote.setRequestMethod(request.method);
            remote.setRequestProperty("Accept-Encoding", "identity");
            remote.setRequestProperty("Connection", "close");
            for (Map.Entry<String, String> header : request.headers.entrySet()) {
                if (FORWARD_HEADERS.contains(header.getKey())) remote.setRequestProperty(header.getKey(), header.getValue());
            }
            if (request.method.equals("POST")) {
                remote.setDoOutput(true);
                remote.setFixedLengthStreamingMode(request.length);
            }
            exchange.requireActive();
            remote.connect();
            exchange.requireActive();
            java.security.cert.Certificate peer = remote.getServerCertificates()[0];
            if (!(peer instanceof X509Certificate) || !MessageDigest.isEqual(peer.getEncoded(), pinnedCertificate)) {
                throw new SSLPeerUnverifiedException("The PC certificate does not match the app certificate.");
            }
            ((X509Certificate) peer).checkValidity();
            if (request.method.equals("POST")) {
                try (OutputStream body = remote.getOutputStream()) { copyExact(input, body, request.length, exchange); }
            }
            exchange.requireActive();
            int status = remote.getResponseCode();
            exchange.requireActive();
            if (status >= 300 && status < 400 && status != 304) throw new ProxyError(502, "proxy_redirect");
            boolean hasBody = !request.method.equals("HEAD") && status != 204 && status != 304;
            StringBuilder headers = new StringBuilder("HTTP/1.1 ").append(status).append(" Response\r\nConnection: close\r\n");
            for (Map.Entry<String, List<String>> header : remote.getHeaderFields().entrySet()) {
                if (header.getKey() == null || !RESPONSE_HEADERS.contains(header.getKey().toLowerCase(Locale.ROOT))) continue;
                for (String value : header.getValue()) {
                    if (value.indexOf('\r') < 0 && value.indexOf('\n') < 0) headers.append(header.getKey()).append(": ").append(value).append("\r\n");
                }
            }
            headers.append(hasBody ? "Transfer-Encoding: chunked\r\n\r\n" : "Content-Length: 0\r\n\r\n");
            output.write(headers.toString().getBytes(StandardCharsets.ISO_8859_1));
            output.flush(); responseStarted = true;
            if (hasBody) {
                InputStream response = status >= 400 ? remote.getErrorStream() : remote.getInputStream();
                if (response != null) {
                    try (InputStream body = response) {
                        byte[] buffer = new byte[16384];
                        int count;
                        while (exchange.active() && (count = body.read(buffer)) != -1) {
                            exchange.requireActive();
                            if (count == 0) continue;
                            output.write(Integer.toHexString(count).getBytes(StandardCharsets.US_ASCII));
                            output.write(new byte[]{13, 10});
                            output.write(buffer, 0, count);
                            output.write(new byte[]{13, 10});
                            output.flush();
                        }
                    }
                }
                if (exchange.active()) { output.write("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); output.flush(); }
            }
        } catch (Exception error) {
            if (!responseStarted && !socket.isClosed()) {
                int status = error instanceof ProxyError ? ((ProxyError) error).status : 502;
                String code = error instanceof ProxyError ? error.getMessage() : "proxy_unavailable";
                String message = ProxyMessages.text(code, language);
                try { sendError(socket.getOutputStream(), status, code, message); } catch (IOException ignored) { }
            }
        } finally {
            exchange.closeTransports();
            if (remote != null) remote.disconnect();
            exchanges.remove(exchange); closeQuietly(socket);
        }
    }

    public void setPaused(boolean value) {
        paused = value;
        if (value) { lifecycle.incrementAndGet(); cancelActive(); }
    }
    private void cancelActive() {
        for (Exchange exchange : exchanges) exchange.cancel();
    }
    @Override public void close() {
        closed = true; paused = true; lifecycle.incrementAndGet();
        closeQuietly(server); cancelActive(); workers.shutdownNow(); cancellations.shutdown();
    }
    int activeRequests() { return exchanges.size(); }

    private final class Exchange {
        final Socket local;
        final long generation = lifecycle.get();
        final Set<Socket> transports = ConcurrentHashMap.newKeySet();
        final AtomicBoolean canceled = new AtomicBoolean(paused || closed);
        final AtomicBoolean cancellationScheduled = new AtomicBoolean();
        Exchange(Socket local) { this.local = local; }
        boolean active() { return !canceled.get() && !paused && !closed && generation == lifecycle.get(); }
        void requireActive() throws IOException { if (!active()) throw new ProxyError(503, "proxy_background"); }
        Socket track(Socket transport) throws IOException {
            transports.add(transport);
            if (!active()) { closeQuietly(transport); throw new SocketException("Request canceled"); }
            return transport;
        }
        void cancel() {
            canceled.set(true);
            closeQuietly(local);
            if (!cancellationScheduled.compareAndSet(false, true)) return;
            // TLS close/disconnect may wait for a reader. Never do that on the
            // Activity thread; closing transport first releases that reader.
            try { cancellations.execute(this::closeTransports); }
            catch (RejectedExecutionException shuttingDown) { /* Request workers also close their transports. */ }
        }
        void closeTransports() {
            for (Socket transport : transports) if (!(transport instanceof SSLSocket)) closeQuietly(transport);
            for (Socket transport : transports) if (transport instanceof SSLSocket) closeQuietly(transport);
        }
    }
    private final class TrackedTlsFactory extends SSLSocketFactory {
        final Exchange exchange;
        TrackedTlsFactory(Exchange exchange) { this.exchange = exchange; }
        @Override public String[] getDefaultCipherSuites() { return tls.getDefaultCipherSuites(); }
        @Override public String[] getSupportedCipherSuites() { return tls.getSupportedCipherSuites(); }
        @Override public Socket createSocket() throws IOException { exchange.requireActive(); return exchange.track(tls.createSocket()); }
        @Override public Socket createSocket(Socket socket, String host, int port, boolean autoClose) throws IOException {
            exchange.track(socket);
            return exchange.track(tls.createSocket(socket, host, port, autoClose));
        }
        @Override public Socket createSocket(String host, int port) throws IOException {
            exchange.requireActive(); return exchange.track(tls.createSocket(host, port));
        }
        @Override public Socket createSocket(String host, int port, InetAddress local, int localPort) throws IOException {
            exchange.requireActive(); return exchange.track(tls.createSocket(host, port, local, localPort));
        }
        @Override public Socket createSocket(InetAddress host, int port) throws IOException {
            exchange.requireActive(); return exchange.track(tls.createSocket(host, port));
        }
        @Override public Socket createSocket(InetAddress host, int port, InetAddress local, int localPort) throws IOException {
            exchange.requireActive(); return exchange.track(tls.createSocket(host, port, local, localPort));
        }
    }
    private static void closeQuietly(Closeable closeable) { try { closeable.close(); } catch (IOException ignored) { } }
    private static void copyExact(InputStream input, OutputStream output, long length, Exchange exchange) throws IOException {
        byte[] buffer = new byte[16384];
        long remaining = length;
        while (remaining > 0) {
            exchange.requireActive();
            int count = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (count < 0) throw new EOFException("Incomplete body");
            exchange.requireActive();
            output.write(buffer, 0, count); remaining -= count;
        }
    }
    private static void sendError(OutputStream output, int status, String code, String message) throws IOException {
        byte[] body = ("{\"errorCode\":\"" + code + "\",\"error\":\"" + message.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}").getBytes(StandardCharsets.UTF_8);
        output.write(("HTTP/1.1 " + status + " Error\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: " + body.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        output.write(body); output.flush();
    }

    static final class ProxyError extends IOException {
        final int status;
        ProxyError(int status, String message) { super(message); this.status = status; }
    }
    static final class Request {
        final String method;
        final String target;
        final Map<String, String> headers;
        final long length;
        Request(String method, String target, Map<String, String> headers, long length) {
            this.method = method; this.target = target; this.headers = headers; this.length = length;
        }
        static Request read(InputStream input, String host, String origin) throws IOException {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            int sequence = 0;
            while (sequence != 4) {
                int value = input.read();
                if (value < 0) throw new ProxyError(400, "proxy_incomplete");
                if (bytes.size() >= MAX_HEADERS) throw new ProxyError(431, "proxy_headers_large");
                bytes.write(value);
                sequence = value == (sequence % 2 == 0 ? 13 : 10) ? sequence + 1 : value == 13 ? 1 : 0;
            }
            String[] lines = new String(bytes.toByteArray(), StandardCharsets.ISO_8859_1).split("\r\n");
            String[] request = lines[0].split(" ", -1);
            if (request.length != 3 || !request[2].equals("HTTP/1.1") || request[1].length() > 4096) throw new ProxyError(400, "proxy_request");
            String method = request[0], target = request[1];
            URI uri;
            try { uri = new URI(target); } catch (URISyntaxException invalid) { throw new ProxyError(400, "proxy_path"); }
            if (!target.startsWith("/") || target.startsWith("//") || uri.isAbsolute() || uri.getRawAuthority() != null || uri.getFragment() != null
                    || uri.getRawPath() == null || uri.getRawPath().contains("%") || !target.matches("[\\x21-\\x7e]+")) throw new ProxyError(400, "proxy_path");
            String path = uri.getRawPath();
            boolean staticGet = STATIC_PATHS.contains(path) && (method.equals("GET") || method.equals("HEAD"));
            boolean apiGet = method.equals("GET") && (path.matches("/api/(health|state|screenshot|stream|audio)") || path.matches("/api/audio/[A-Za-z0-9_-]{1,100}"));
            boolean apiPost = method.equals("POST") && (path.matches("/api/(action|audio)") || path.equals("/api/audio/stop") || path.matches("/api/audio/[A-Za-z0-9_-]{1,100}/play"));
            if (!(staticGet || apiGet || apiPost)) throw new ProxyError(404, "proxy_path_denied");
            Map<String, String> headers = new LinkedHashMap<>();
            for (int index = 1; index < lines.length; index++) {
                if (lines[index].isEmpty()) continue;
                int colon = lines[index].indexOf(':');
                if (colon < 1) throw new ProxyError(400, "proxy_header");
                String name = lines[index].substring(0, colon).toLowerCase(Locale.ROOT);
                String value = lines[index].substring(colon + 1).trim();
                if (!name.matches("[a-z0-9!#$%&'*+.^_`|~-]+") || !value.matches("[\\x20-\\x7e]*") || headers.put(name, value) != null) throw new ProxyError(400, "proxy_header");
            }
            if (!host.equals(headers.get("host"))) throw new ProxyError(403, "proxy_host");
            String requestOrigin = headers.get("origin");
            String referer = headers.get("referer");
            if ((requestOrigin != null && !requestOrigin.equals(origin)) || (referer != null && !(referer.equals(origin) || referer.startsWith(origin + "/")))) throw new ProxyError(403, "proxy_origin");
            if (headers.containsKey("transfer-encoding")) throw new ProxyError(400, "proxy_encoding");
            if (headers.containsKey("expect")) throw new ProxyError(417, "proxy_expect");
            String contentLength = headers.get("content-length");
            long length = 0;
            if (contentLength != null) {
                if (!contentLength.matches("[0-9]{1,10}")) throw new ProxyError(400, "proxy_size");
                length = Long.parseLong(contentLength);
                if (length > MAX_BODY) throw new ProxyError(413, "proxy_limit");
            }
            if (!method.equals("POST") && length != 0) throw new ProxyError(400, "proxy_body");
            return new Request(method, target, headers, length);
        }
    }
}
