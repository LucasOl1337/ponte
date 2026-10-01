package app.ponte.omarchy;

import java.io.InputStream;
import java.security.*;
import java.security.cert.*;
import java.util.Locale;
import javax.net.ssl.*;

/**
 * TLS to the PC, trusting only the Ponte installation CA shipped with the app
 * (or that certificate itself when it is self-signed). Shared by the loopback
 * proxy and the agent alert service so both check the PC the same way.
 */
final class PinnedTls {
    private final X509Certificate anchor;
    private final byte[] pinnedAnchor;
    private final SSLSocketFactory factory;

    PinnedTls(InputStream certificatePem) throws Exception {
        X509Certificate certificate = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(certificatePem);
        certificate.checkValidity();
        anchor = certificate;
        pinnedAnchor = certificate.getEncoded();
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
                requirePinnedIssuer(chain.length == 0 ? null : chain[0]);
            }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{pinnedTrust}, new SecureRandom());
        factory = context.getSocketFactory();
    }

    SSLSocketFactory socketFactory() { return factory; }

    /**
     * The validated leaf must be the pinned anchor itself or be issued directly
     * by it. The trust store only holds the anchor, so platform validation has
     * already required the path to end there; this is the explicit pin check.
     */
    void requirePinnedIssuer(X509Certificate leaf) throws CertificateException {
        if (leaf == null) throw new CertificateException("The PC presented no certificate.");
        leaf.checkValidity();
        if (MessageDigest.isEqual(leaf.getEncoded(), pinnedAnchor)) return;
        try { leaf.verify(anchor.getPublicKey()); }
        catch (GeneralSecurityException notIssuedHere) { throw new CertificateException("The PC certificate was not issued by the app's pinned CA."); }
        if (!leaf.getIssuerX500Principal().equals(anchor.getSubjectX500Principal())) throw new CertificateException("The PC certificate was not issued by the app's pinned CA.");
    }

    /** After connecting: the certificate the PC actually presented must pass the pin. */
    void requirePinnedPeer(HttpsURLConnection connection) throws SSLPeerUnverifiedException {
        java.security.cert.Certificate peer = connection.getServerCertificates()[0];
        if (!(peer instanceof X509Certificate)) throw new SSLPeerUnverifiedException("The PC did not present an X.509 certificate.");
        try { requirePinnedIssuer((X509Certificate) peer); }
        catch (CertificateException mismatch) { throw new SSLPeerUnverifiedException(mismatch.getMessage()); }
    }

    /** The same check on a raw TLS socket (the remote desktop WebSocket tunnel). */
    void requirePinnedPeer(SSLSocket socket) throws SSLPeerUnverifiedException {
        java.security.cert.Certificate peer = socket.getSession().getPeerCertificates()[0];
        if (!(peer instanceof X509Certificate)) throw new SSLPeerUnverifiedException("The PC did not present an X.509 certificate.");
        try { requirePinnedIssuer((X509Certificate) peer); }
        catch (CertificateException mismatch) { throw new SSLPeerUnverifiedException(mismatch.getMessage()); }
    }

    /** A handshake that failed on trust, not on reachability: the app and the PC disagree on the certificate. */
    static boolean certificateFailure(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof SSLPeerUnverifiedException || cause instanceof CertificateException) return true;
            if (cause instanceof SSLHandshakeException && cause.getMessage() != null && cause.getMessage().toLowerCase(Locale.ROOT).contains("certificate")) return true;
        }
        return false;
    }
}
