package app.ponte.omarchy;

import java.io.IOException;
import java.net.*;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class WakeOnLan {
    public static final int WOL_PORT = 9;
    public static final int MAGIC_PACKET_LENGTH = 102;

    private WakeOnLan() {}

    public static byte[] parseMac(String mac) {
        if (mac == null) throw new IllegalArgumentException("MAC address cannot be null");
        String clean = mac.trim().replaceAll("[:-]", "");
        if (!clean.matches("^[0-9a-fA-F]{12}$")) {
            throw new IllegalArgumentException("Invalid MAC address: " + mac);
        }
        byte[] bytes = new byte[6];
        for (int i = 0; i < 6; i++) {
            bytes[i] = (byte) Integer.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    }

    public static byte[] buildMagicPacket(String mac) {
        byte[] macBytes = parseMac(mac);
        byte[] packet = new byte[MAGIC_PACKET_LENGTH];
        Arrays.fill(packet, 0, 6, (byte) 0xFF);
        for (int i = 6; i < MAGIC_PACKET_LENGTH; i += 6) {
            System.arraycopy(macBytes, 0, packet, i, 6);
        }
        return packet;
    }

    public static String extractMac(String json) {
        if (json == null) return null;
        Pattern pattern = Pattern.compile("\"wakeOnLan\"\\s*:\\s*\\{[^}]*?\"mac\"\\s*:\\s*\"([0-9a-fA-F:]{17})\"");
        Matcher matcher = pattern.matcher(json);
        if (matcher.find()) {
            return matcher.group(1).toLowerCase(Locale.ROOT);
        }
        Pattern fallback = Pattern.compile("\"mac\"\\s*:\\s*\"([0-9a-fA-F:]{17})\"");
        matcher = fallback.matcher(json);
        if (matcher.find()) {
            return matcher.group(1).toLowerCase(Locale.ROOT);
        }
        return null;
    }

    public static List<InetAddress> getBroadcastAddresses() {
        Set<InetAddress> addresses = new LinkedHashSet<>();
        try {
            addresses.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) { }

        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces != null) {
                while (interfaces.hasMoreElements()) {
                    NetworkInterface iface = interfaces.nextElement();
                    try {
                        if (!iface.isUp() || iface.isLoopback()) continue;
                        for (InterfaceAddress addr : iface.getInterfaceAddresses()) {
                            InetAddress broadcast = addr.getBroadcast();
                            if (broadcast != null) {
                                addresses.add(broadcast);
                            }
                        }
                    } catch (Exception ignored) { }
                }
            }
        } catch (Exception ignored) { }
        return new ArrayList<>(addresses);
    }

    public static int sendMagicPackets(String mac) throws IOException {
        byte[] packetData = buildMagicPacket(mac);
        List<InetAddress> targets = getBroadcastAddresses();
        int sent = 0;
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            for (int round = 0; round < 3; round++) {
                for (InetAddress target : targets) {
                    try {
                        DatagramPacket packet = new DatagramPacket(packetData, packetData.length, target, WOL_PORT);
                        socket.send(packet);
                        sent++;
                    } catch (IOException ignored) { }
                }
                if (round < 2) {
                    try { Thread.sleep(100); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
                }
            }
        }
        return sent;
    }
}
