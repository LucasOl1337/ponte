package app.ponte.omarchy;

public final class LoadRetryTest {
    static int checks;
    static void check(boolean value, String description) { if (!value) throw new AssertionError(description); checks++; }
    public static void main(String[] args) {
        // The PC is unreachable: the proxy answers 502 and Chromium commits that
        // body, so onPageFinished arrives after the failure for the same load.
        LoadRetry load = new LoadRetry();
        load.begin();
        int first = load.fail();
        load.finished();
        check(load.failed(), "the committed error body does not clear the failure");
        check(load.current(first), "the retry timer of a failed load still fires");
        check(load.attempts() == 1, "the error body does not reset the retry count");

        // The health check fails again: the next retry supersedes the first.
        int second = load.fail();
        check(second == 2 && !load.current(first) && load.current(second), "a stale timer cannot load twice");

        // Leaving and coming back while the message is up reloads the page.
        check(load.failed(), "resume sees the failure and reloads");

        // The PC answers: a new load begins and finishes cleanly.
        load.begin();
        check(!load.failed() && !load.current(second), "a new load cancels pending retries");
        load.finished();
        check(load.attempts() == 0, "a successful load resets the retry count");

        check(LoadRetry.delay(1) == 1500 && LoadRetry.delay(2) == 3000 && LoadRetry.delay(4) == 12000, "backoff doubles from 1.5 s");
        check(LoadRetry.delay(5) == 15000 && LoadRetry.delay(500) == 15000, "retries go on every 15 s");
        System.out.println("Load retries: " + checks + " checks passed.");
    }
}
