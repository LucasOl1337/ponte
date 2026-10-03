package app.ponte.omarchy;

/**
 * Whether the home page load failed and which retry is current.
 *
 * A failure is cleared only when a new load of the home page begins, never by
 * the WebView's page callbacks: for an HTTP error (the proxy's 502 while the
 * PC is unreachable) Chromium reports onReceivedHttpError first and then
 * commits the error body, firing onPageStarted and onPageFinished for it.
 * Clearing the failure there killed the pending retry and the resume reload,
 * and the app stayed on "Connecting to your PC" until it was force-stopped.
 */
final class LoadRetry {
    private int attempts;
    private boolean failed;

    /** A new load of the home page starts. */
    void begin() { failed = false; }
    /** The main frame failed; returns the number of this retry. */
    int fail() { failed = true; return ++attempts; }
    /** A main-frame page finished; only a load that did not fail resets the count. */
    void finished() { if (!failed) attempts = 0; }
    boolean failed() { return failed; }
    int attempts() { return attempts; }
    /** A timer or health check scheduled for {@code attempt} may still act. */
    boolean current(int attempt) { return failed && attempts == attempt; }

    // 1.5, 3, 6, 12 s, then every 15 s until the PC answers.
    static long delay(int attempt) { return Math.min(15000L, 1500L << Math.max(0, Math.min(attempt - 1, 4))); }
}
