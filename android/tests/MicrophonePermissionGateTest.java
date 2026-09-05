package app.ponte.omarchy;

public final class MicrophonePermissionGateTest {
    static int checks;
    static void check(boolean value, String description) { if (!value) throw new AssertionError(description); checks++; }
    public static void main(String[] args) {
        MicrophonePermissionGate gate = new MicrophonePermissionGate();
        int first = gate.begin();
        check(gate.pause(), "permission dialog pause preserves the pending request");
        check(gate.receive(first, true), "permission result belongs to pending request");
        check(gate.takeDecision() == null, "grant cannot start capture before Activity resumes");
        gate.resume();
        check(Boolean.TRUE.equals(gate.takeDecision()), "first permission grant completes on resume");
        check(gate.takeDecision() == null, "grant is delivered once");
        check(!gate.pause(), "normal background pause has no permission exemption");
        gate.resume();
        int second = gate.begin();
        gate.pause(); gate.stop();
        check(!gate.receive(second, true), "leaving the app ignores a late grant");
        gate.resume();
        check(gate.takeDecision() == null, "returning from background cannot revive old capture");
        int third = gate.begin();
        check(third != second, "new request gets a distinct Android request code");
        check(!gate.receive(second, true), "old callback cannot grant a newer request");
        check(gate.receive(third, false), "matching denial is accepted");
        check(Boolean.FALSE.equals(gate.takeDecision()), "denial reaches WebView");
        int fourth = gate.begin();
        gate.pause(); gate.resume();
        check(gate.receive(fourth, true), "result after resume is accepted");
        check(Boolean.TRUE.equals(gate.takeDecision()), "result after resume grants immediately");
        int fifth = gate.begin(); gate.cancel();
        check(!gate.receive(fifth, true), "WebView cancellation prevents late grant");
        check(!gate.pause(), "canceled request cannot exempt a later background pause");
        gate.resume();
        int sixth = gate.begin(); gate.pause(); gate.receive(sixth, true); gate.stop(); gate.resume();
        check(gate.takeDecision() == null, "background after Android result cancels deferred grant");
        System.out.println("Microphone permission lifecycle: " + checks + " checks passed.");
    }
}
