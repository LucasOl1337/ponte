package app.ponte.omarchy;

import java.util.*;

public final class AgentAlertsTest {
    static int checks;
    static void check(boolean value, String description) { if (!value) throw new AssertionError(description); checks++; }
    static boolean rejects(String body) {
        try { AgentAlerts.parse(body); return false; } catch (IllegalArgumentException expected) { return true; }
    }
    public static void main(String[] args) {
        // Baseline: no events, only the seq to continue from.
        AgentAlerts.Batch baseline = AgentAlerts.parse("{\"seq\":0,\"events\":[]}");
        check(baseline.seq == 0 && baseline.events.isEmpty(), "baseline answer");
        check(AgentAlerts.eventsPath(-1).equals("/api/agents/events?wait=50"), "first request asks for the baseline");
        check(AgentAlerts.eventsPath(7).equals("/api/agents/events?after=7&wait=50"), "later requests continue after the last seq");

        // Synthetic events in the server's format.
        String body = "{\"seq\":12,\"events\":["
            + "{\"seq\":11,\"id\":\"p-4242-99\",\"kind\":\"claude\",\"title\":\"Sample \\\"one\\\"\\n\\tproject\",\"to\":\"waiting\",\"waitingFor\":\"input needed\",\"at\":1770000000000},"
            + "{\"seq\":12,\"id\":\"w-0a1b\",\"kind\":\"codex\",\"title\":\"Sample \\u00e7\",\"to\":\"ready\",\"waitingFor\":null,\"at\":1770000000001},"
            + "{\"seq\":13,\"id\":\"../../etc\",\"kind\":\"claude\",\"title\":\"bad id\",\"to\":\"ready\"},"
            + "{\"seq\":14,\"id\":\"p-1-1\",\"kind\":\"claude\",\"title\":\"bad move\",\"to\":\"working\"},"
            + "{\"seq\":-1,\"id\":\"p-1-2\",\"to\":\"ready\"},"
            + "\"not an object\""
            + "],\"extra\":{\"nested\":[1,2.5,-3e2,true,false,null]}}";
        AgentAlerts.Batch batch = AgentAlerts.parse(body);
        check(batch.seq == 12, "batch seq");
        check(batch.events.size() == 2, "invalid ids, transitions and seqs are skipped: " + batch.events.size());
        AgentAlerts.Event first = batch.events.get(0), second = batch.events.get(1);
        check(first.seq == 11 && first.id.equals("p-4242-99") && first.waiting, "waiting event");
        check(first.title.equals("Sample \"one\" project"), "title is one clean line: " + first.title);
        check(first.waitingFor.equals("input needed"), "waitingFor kept");
        check(second.id.equals("w-0a1b") && !second.waiting && second.waitingFor.isEmpty(), "ready event without waitingFor");
        check(second.title.equals("Sample ç"), "unicode escape");

        // Texts, both languages.
        check(AgentAlerts.title(first, true).equals("Sample \"one\" project precisa de você"), "pt waiting title");
        check(AgentAlerts.title(second, false).equals("Sample ç finished"), "en ready title");
        check(AgentAlerts.title(second, true).equals("Sample ç terminou"), "pt ready title");
        check(AgentAlerts.detail(first, false).equals("input needed"), "waiting detail is what it waits for");
        check(AgentAlerts.detail(second, true).equals("Toque pra abrir a conversa."), "ready detail invites a tap");
        check(AgentAlerts.lockedTitle(first, true).equals("Um agente precisa de você"), "lock screen hides the name");
        check(AgentAlerts.watchingTitle(true).equals("Ponte vigiando seus agentes"), "persistent notification title");
        check(AgentAlerts.turnOff(true).equals("Desligar") && AgentAlerts.turnOff(false).equals("Turn off"), "turn off action");
        check(AgentAlerts.portuguese("pt") && !AgentAlerts.portuguese("en") && !AgentAlerts.portuguese(null), "language preference");
        AgentAlerts.Event untitled = AgentAlerts.parse("{\"seq\":1,\"events\":[{\"seq\":1,\"id\":\"p-1-1\",\"to\":\"ready\"}]}").events.get(0);
        check(AgentAlerts.title(untitled, false).equals("An agent finished"), "missing title falls back");

        // Long text is clipped with an ellipsis.
        StringBuilder longTitle = new StringBuilder();
        for (int index = 0; index < 300; index++) longTitle.append('x');
        AgentAlerts.Event clipped = AgentAlerts.parse("{\"seq\":1,\"events\":[{\"seq\":1,\"id\":\"p-1-1\",\"title\":\"" + longTitle + "\",\"to\":\"ready\"}]}").events.get(0);
        check(clipped.title.length() == 120 && clipped.title.endsWith("…"), "title clipped to 120");
        check(AgentAlerts.clean("abc", 3).equals("abc"), "exact fit is not clipped");

        // Anything that is not the expected shape is refused as a whole.
        check(rejects(null), "null body");
        check(rejects(""), "empty body");
        check(rejects("[]"), "array root");
        check(rejects("{\"seq\":\"1\",\"events\":[]}"), "string seq");
        check(rejects("{\"seq\":1.5,\"events\":[]}"), "fractional seq");
        check(rejects("{\"seq\":-1,\"events\":[]}"), "negative seq");
        check(rejects("{\"seq\":1}"), "missing events");
        check(rejects("{\"seq\":1,\"events\":[]} trailing"), "trailing text");
        check(rejects("{\"seq\":1,\"events\":[}"), "broken array");
        check(rejects("{\"seq\":01,\"events\":[]}"), "leading zero");
        check(rejects("{\"seq\":1,\"events\":[],\"x\":\"a\u0001b\"}"), "raw control character");
        check(rejects("{\"seq\":1,\"events\":[],\"x\":\"\\q\"}"), "bad escape");
        StringBuilder deep = new StringBuilder("{\"seq\":1,\"events\":[],\"x\":");
        for (int index = 0; index < 20; index++) deep.append('[');
        for (int index = 0; index < 20; index++) deep.append(']');
        check(rejects(deep.append('}').toString()), "nesting is bounded");
        StringBuilder big = new StringBuilder("{\"seq\":1,\"events\":[],\"x\":\"");
        while (big.length() <= AgentAlerts.MAX_BODY) big.append("aaaaaaaaaaaaaaaa");
        check(rejects(big.append("\"}").toString()), "body size is bounded");

        // Reconnect delays: 5 s doubling to a 5 min ceiling; zero after a success.
        long[] expected = {0, 5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000};
        for (int failures = 0; failures < expected.length; failures++) check(AgentAlerts.backoffMs(failures) == expected[failures], "backoff after " + failures + " failures");
        check(AgentAlerts.backoffMs(Integer.MAX_VALUE) == 300000, "no overflow after many failures");

        // Ids and tokens handed across the notification and the page bridge.
        check(AgentAlerts.validAgentId("p-12-34") && AgentAlerts.validAgentId("w-deadbeef"), "valid agent ids");
        check(!AgentAlerts.validAgentId("p-12") && !AgentAlerts.validAgentId("w-XYZ") && !AgentAlerts.validAgentId("p-1-1\n") && !AgentAlerts.validAgentId(null), "invalid agent ids");
        check(AgentAlerts.validToken("synthetic_token-0123456789abcdefABCDEF") && !AgentAlerts.validToken("short") && !AgentAlerts.validToken("bad token with spaces 0123456789abcdef"), "token shape");
        System.out.println("Agent alerts: " + checks + " checks passed.");
    }
}
