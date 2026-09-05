package app.ponte.omarchy;

/** Runtime permission results belong to one visible WebView request. */
final class MicrophonePermissionGate {
    private int nextCode = 1000;
    private int activeCode;
    private boolean paused;
    private Boolean result;

    int begin() {
        if (++nextCode > 65535) nextCode = 1000;
        activeCode = nextCode;
        result = null;
        return activeCode;
    }
    boolean pause() {
        paused = true;
        return activeCode != 0 && result == null;
    }
    void resume() { paused = false; }
    void stop() { paused = true; cancel(); }
    void cancel() { activeCode = 0; result = null; }
    boolean receive(int code, boolean granted) {
        if (activeCode == 0 || code != activeCode) return false;
        result = granted;
        return true;
    }
    Boolean takeDecision() {
        if (paused || activeCode == 0 || result == null) return null;
        Boolean decision = result;
        cancel();
        return decision;
    }
}
