package app.ponte.omarchy;

import java.util.*;
import java.util.regex.Pattern;

/**
 * The plain-Java part of the agent alerts: reading the PC's event batches,
 * the reconnect delays and the notification texts. No Android types, so the
 * native tests run it on a desktop JVM.
 */
final class AgentAlerts {
    private AgentAlerts() {}

    /** The same agent ids the loopback proxy lets through. */
    static final Pattern AGENT_ID = Pattern.compile("p-[0-9]{1,10}-[0-9]{1,20}|w-[0-9a-f]{1,32}");
    static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{32,128}");
    static final int WAIT_SECONDS = 50;
    static final int MAX_BODY = 64 * 1024;
    static final long FIRST_DELAY_MS = 5000;
    static final long MAX_DELAY_MS = 5 * 60 * 1000;
    private static final int MAX_EVENTS = 50;
    private static final int MAX_DEPTH = 8;

    static boolean validAgentId(String id) { return id != null && AGENT_ID.matcher(id).matches(); }
    static boolean validToken(String token) { return token != null && TOKEN.matcher(token).matches(); }

    /** 5 s, 10 s, 20 s … doubling after each failure in a row, never above 5 min. */
    static long backoffMs(int failures) {
        if (failures <= 0) return 0;
        long delay = FIRST_DELAY_MS;
        for (int count = 1; count < failures && delay < MAX_DELAY_MS; count++) delay *= 2;
        return Math.min(delay, MAX_DELAY_MS);
    }

    static String eventsPath(long after) {
        return "/api/agents/events?" + (after >= 0 ? "after=" + after + "&" : "") + "wait=" + WAIT_SECONDS;
    }

    static final class Event {
        final long seq; final String id; final String kind; final String title; final boolean waiting; final String waitingFor;
        Event(long seq, String id, String kind, String title, boolean waiting, String waitingFor) {
            this.seq = seq; this.id = id; this.kind = kind; this.title = title; this.waiting = waiting; this.waitingFor = waitingFor;
        }
    }
    static final class Batch {
        final long seq; final List<Event> events;
        Batch(long seq, List<Event> events) { this.seq = seq; this.events = events; }
    }

    /**
     * One answer from /api/agents/events. The root must be well formed; an
     * event that is not (unknown id format, unknown transition) is skipped.
     */
    static Batch parse(String body) {
        if (body == null || body.length() > MAX_BODY) throw new IllegalArgumentException("body");
        Object root = new Json(body).document();
        if (!(root instanceof Map)) throw new IllegalArgumentException("root");
        Map<?, ?> object = (Map<?, ?>) root;
        long seq = count(object.get("seq"));
        if (seq < 0) throw new IllegalArgumentException("seq");
        Object list = object.get("events");
        if (!(list instanceof List)) throw new IllegalArgumentException("events");
        List<Event> events = new ArrayList<>();
        for (Object item : (List<?>) list) {
            if (events.size() >= MAX_EVENTS || !(item instanceof Map)) continue;
            Map<?, ?> entry = (Map<?, ?>) item;
            Object id = entry.get("id"), to = entry.get("to");
            long eventSeq = count(entry.get("seq"));
            if (!(id instanceof String) || !validAgentId((String) id) || eventSeq < 0) continue;
            if (!"waiting".equals(to) && !"ready".equals(to)) continue;
            String kind = entry.get("kind") instanceof String ? clean((String) entry.get("kind"), 40) : "";
            String title = entry.get("title") instanceof String ? clean((String) entry.get("title"), 120) : "";
            String waitingFor = entry.get("waitingFor") instanceof String ? clean((String) entry.get("waitingFor"), 160) : "";
            events.add(new Event(eventSeq, (String) id, kind, title, "waiting".equals(to), waitingFor));
        }
        return new Batch(seq, events);
    }

    private static long count(Object value) {
        if (!(value instanceof Double)) return -1;
        double number = (Double) value;
        return number >= 0 && number <= 9007199254740991d && number == Math.floor(number) ? (long) number : -1;
    }

    /** One line, no control characters, bounded. */
    static String clean(String text, int max) {
        StringBuilder out = new StringBuilder();
        boolean space = false, cut = false;
        for (int index = 0; index < text.length(); index++) {
            char c = text.charAt(index);
            if (Character.isWhitespace(c) || Character.isISOControl(c)) { space = out.length() > 0; continue; }
            if (out.length() + (space ? 1 : 0) >= max) { cut = true; break; }
            if (space) { out.append(' '); space = false; }
            out.append(c);
        }
        if (cut) { out.setLength(Math.max(0, max - 1)); out.append('…'); }
        return out.toString();
    }

    static boolean portuguese(String language) { return "pt".equals(language); }

    static String title(Event event, boolean pt) {
        String name = event.title.isEmpty() ? (pt ? "Um agente" : "An agent") : event.title;
        if (event.waiting) return pt ? name + " precisa de você" : name + " needs you";
        return pt ? name + " terminou" : name + " finished";
    }
    static String detail(Event event, boolean pt) {
        if (event.waiting && !event.waitingFor.isEmpty()) return event.waitingFor;
        return pt ? "Toque pra abrir a conversa." : "Tap to open the conversation.";
    }
    /** What a locked screen shows instead of the agent's name. */
    static String lockedTitle(Event event, boolean pt) {
        if (event.waiting) return pt ? "Um agente precisa de você" : "An agent needs you";
        return pt ? "Um agente terminou" : "An agent finished";
    }
    static String watchingTitle(boolean pt) { return pt ? "Ponte vigiando seus agentes" : "Ponte is watching your agents"; }
    static String watchingText(boolean pt) { return pt ? "Avisa quando um agente precisar de você ou terminar." : "Alerts you when an agent needs you or finishes."; }
    static String turnOff(boolean pt) { return pt ? "Desligar" : "Turn off"; }
    static String watchChannel(boolean pt) { return pt ? "Vigia dos agentes" : "Agent watch"; }
    static String alertChannel(boolean pt) { return pt ? "Avisos de agentes" : "Agent alerts"; }

    /** A small strict JSON reader: objects, arrays, strings, numbers, true, false, null. */
    private static final class Json {
        private final String text;
        private int at;
        private int depth;
        Json(String text) { this.text = text; }
        Object document() {
            Object value = value();
            space();
            if (at != text.length()) throw new IllegalArgumentException("trailing");
            return value;
        }
        private void space() { while (at < text.length() && " \t\r\n".indexOf(text.charAt(at)) >= 0) at++; }
        private char peek() { if (at >= text.length()) throw new IllegalArgumentException("end"); return text.charAt(at); }
        private void expect(char c) { if (peek() != c) throw new IllegalArgumentException("expected " + c); at++; }
        private Object value() {
            space();
            char c = peek();
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (text.startsWith("true", at)) { at += 4; return Boolean.TRUE; }
            if (text.startsWith("false", at)) { at += 5; return Boolean.FALSE; }
            if (text.startsWith("null", at)) { at += 4; return null; }
            return number();
        }
        private Map<String, Object> object() {
            if (++depth > MAX_DEPTH) throw new IllegalArgumentException("depth");
            expect('{');
            Map<String, Object> out = new LinkedHashMap<>();
            space();
            if (peek() == '}') { at++; depth--; return out; }
            for (;;) {
                space();
                String key = string();
                space(); expect(':');
                out.put(key, value());
                space();
                if (peek() == ',') { at++; continue; }
                expect('}'); depth--; return out;
            }
        }
        private List<Object> array() {
            if (++depth > MAX_DEPTH) throw new IllegalArgumentException("depth");
            expect('[');
            List<Object> out = new ArrayList<>();
            space();
            if (peek() == ']') { at++; depth--; return out; }
            for (;;) {
                out.add(value());
                space();
                if (peek() == ',') { at++; continue; }
                expect(']'); depth--; return out;
            }
        }
        private String string() {
            expect('"');
            StringBuilder out = new StringBuilder();
            for (;;) {
                char c = peek(); at++;
                if (c == '"') return out.toString();
                if (c < 0x20) throw new IllegalArgumentException("control");
                if (c != '\\') { out.append(c); continue; }
                char escape = peek(); at++;
                switch (escape) {
                    case '"': out.append('"'); break;
                    case '\\': out.append('\\'); break;
                    case '/': out.append('/'); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'u':
                        if (at + 4 > text.length()) throw new IllegalArgumentException("escape");
                        try { out.append((char) Integer.parseInt(text.substring(at, at + 4), 16)); }
                        catch (NumberFormatException invalid) { throw new IllegalArgumentException("escape"); }
                        at += 4; break;
                    default: throw new IllegalArgumentException("escape");
                }
            }
        }
        private Double number() {
            int start = at;
            if (at < text.length() && text.charAt(at) == '-') at++;
            while (at < text.length() && "0123456789.eE+-".indexOf(text.charAt(at)) >= 0) at++;
            String literal = text.substring(start, at);
            if (!literal.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")) throw new IllegalArgumentException("number");
            return Double.valueOf(literal);
        }
    }
}
