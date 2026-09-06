package app.ponte.omarchy;

import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.*;

public final class WakeOnLanTest {
    static int checks;
    static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }

    static void testMagicPacketConstruction() {
        String mac = "d8:43:ae:8b:e8:a8";
        byte[] packet = WakeOnLan.buildMagicPacket(mac);
        check(packet.length == 102, "Magic packet must be exactly 102 bytes");

        // First 6 bytes must be 0xFF
        for (int i = 0; i < 6; i++) {
            check(packet[i] == (byte) 0xFF, "Byte " + i + " must be 0xFF");
        }

        // Next 96 bytes must be 16 repetitions of MAC
        byte[] expectedMac = new byte[]{(byte) 0xd8, (byte) 0x43, (byte) 0xae, (byte) 0x8b, (byte) 0xe8, (byte) 0xa8};
        for (int rep = 0; rep < 16; rep++) {
            for (int b = 0; b < 6; b++) {
                check(packet[6 + rep * 6 + b] == expectedMac[b], "Repetition " + rep + " byte " + b + " mismatch");
            }
        }

        // Test uppercase format
        byte[] upperPacket = WakeOnLan.buildMagicPacket("D8:43:AE:8B:E8:A8");
        check(Arrays.equals(packet, upperPacket), "Uppercase MAC must yield identical packet");

        // Test hyphenated format
        byte[] hyphenPacket = WakeOnLan.buildMagicPacket("d8-43-ae-8b-e8-a8");
        check(Arrays.equals(packet, hyphenPacket), "Hyphenated MAC must yield identical packet");

        // Test format without delimiters
        byte[] plainPacket = WakeOnLan.buildMagicPacket("d843ae8be8a8");
        check(Arrays.equals(packet, plainPacket), "Plain hex MAC must yield identical packet");

        // Invalid MACs must throw IllegalArgumentException
        String[] invalidMacs = {null, "", "   ", "invalid", "d8:43:ae:8b:e8", "d8:43:ae:8b:e8:a8:11", "d8:43:ae:8b:e8:zz"};
        for (String invalid : invalidMacs) {
            boolean thrown = false;
            try {
                WakeOnLan.buildMagicPacket(invalid);
            } catch (IllegalArgumentException e) {
                thrown = true;
            }
            check(thrown, "Invalid MAC '" + invalid + "' must throw IllegalArgumentException");
        }
    }

    static void testMacExtraction() {
        String jsonWithWol = "{\"hostname\":\"omarchy\",\"wakeOnLan\":{\"mac\":\"d8:43:ae:8b:e8:a8\",\"interface\":\"enp12s0\"}}";
        check("d8:43:ae:8b:e8:a8".equals(WakeOnLan.extractMac(jsonWithWol)), "Must extract MAC from wakeOnLan object");

        String jsonWithWhitespace = "{\n  \"wakeOnLan\": {\n    \"mac\": \"D8:43:AE:8B:E8:A8\",\n    \"interface\": \"enp12s0\"\n  }\n}";
        check("d8:43:ae:8b:e8:a8".equals(WakeOnLan.extractMac(jsonWithWhitespace)), "Must normalize uppercase and handle multiline");

        String jsonFlatMac = "{\"hostname\":\"omarchy\",\"mac\":\"11:22:33:44:55:66\"}";
        check("11:22:33:44:55:66".equals(WakeOnLan.extractMac(jsonFlatMac)), "Must extract flat MAC fallback");

        check(WakeOnLan.extractMac(null) == null, "Null json must return null");
        check(WakeOnLan.extractMac("{}") == null, "Empty json must return null");
        check(WakeOnLan.extractMac("{\"other\":123}") == null, "Missing MAC must return null");
    }

    static void testBroadcastAddresses() {
        List<InetAddress> broadcasts = WakeOnLan.getBroadcastAddresses();
        check(!broadcasts.isEmpty(), "Broadcast addresses must not be empty");
        boolean hasUniversal = false;
        for (InetAddress addr : broadcasts) {
            if ("255.255.255.255".equals(addr.getHostAddress())) hasUniversal = true;
        }
        check(hasUniversal, "Must include 255.255.255.255");
    }

    static void testMacPersistenceThroughProxy(Path fixtures) throws Exception {
        // Set up TLS server mimicking /api/state with wakeOnLan
        KeyStore keys = KeyStore.getInstance("PKCS12");
        try (InputStream input = Files.newInputStream(fixtures.resolve("good.p12"))) { keys.load(input, "test-only".toCharArray()); }
        KeyManagerFactory km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        km.init(keys, "test-only".toCharArray());
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(km.getKeyManagers(), null, null);
        HttpsServer server = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 8);
        server.setHttpsConfigurator(new HttpsConfigurator(tls));
        server.createContext("/api/state", exchange -> {
            byte[] body = "{\"hostname\":\"omarchy\",\"wakeOnLan\":{\"mac\":\"d8:43:ae:8b:e8:a8\",\"interface\":\"enp12s0\"}}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(body); }
        });
        server.start();

        try {
            AtomicReference<String> capturedMac = new AtomicReference<>();
            Map<String, String> simulatedPreferences = new HashMap<>();

            LoopbackProxy.StateListener listener = mac -> {
                capturedMac.set(mac);
                simulatedPreferences.put("wol_mac", mac);
            };

            URI upstream = URI.create("https://127.0.0.1:" + server.getAddress().getPort());
            try (InputStream certIn = Files.newInputStream(fixtures.resolve("good.crt"));
                 LoopbackProxy proxy = new LoopbackProxy(upstream, certIn, 0, listener)) {

                URI proxyOrigin = URI.create(proxy.origin());
                try (Socket client = new Socket("127.0.0.1", proxyOrigin.getPort())) {
                    String req = "GET /api/state HTTP/1.1\r\nHost: " + proxyOrigin.getAuthority() + "\r\nAuthorization: Bearer test\r\n\r\n";
                    client.getOutputStream().write(req.getBytes(StandardCharsets.US_ASCII));
                    client.getOutputStream().flush();
                    byte[] response = client.getInputStream().readAllBytes();
                    String respStr = new String(response, StandardCharsets.UTF_8);
                    check(respStr.contains("200 Response"), "Proxy must return 200");
                }

                // Check that listener captured MAC and persisted to preferences
                check("d8:43:ae:8b:e8:a8".equals(capturedMac.get()), "Proxy must notify listener with extracted MAC");
                check("d8:43:ae:8b:e8:a8".equals(simulatedPreferences.get("wol_mac")), "Preferences must persist MAC address");
            }
        } finally {
            server.stop(0);
        }
    }

    public static void main(String[] args) throws Exception {
        checks = 0;
        testMagicPacketConstruction();
        testMacExtraction();
        testBroadcastAddresses();
        if (args.length > 0) {
            testMacPersistenceThroughProxy(Paths.get(args[0]));
        }
        System.out.println("WakeOnLan: " + checks + " checks passed.");
    }
}
