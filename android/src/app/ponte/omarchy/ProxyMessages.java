package app.ponte.omarchy;

final class ProxyMessages {
    private ProxyMessages() {}
    static String text(String code, String language) {
        boolean pt = language != null && language.toLowerCase(java.util.Locale.ROOT).matches("^pt(?:-[a-z]+)?(?:[,;].*)?$");
        switch (code) {
            case "proxy_redirect": return pt ? "O PC tentou redirecionar a conexão." : "The PC tried to redirect the connection.";
            case "proxy_unavailable": return pt ? "Não foi possível conectar ao PC com segurança. Confira o Tailscale." : "Could not connect securely to the PC. Check Tailscale.";
            case "proxy_background": return pt ? "Ponte está em segundo plano." : "Ponte is in the background.";
            case "proxy_incomplete": return pt ? "Pedido incompleto." : "Incomplete request.";
            case "proxy_headers_large": return pt ? "Cabeçalho muito grande." : "Request headers are too large.";
            case "proxy_request": return pt ? "Pedido inválido." : "Invalid request.";
            case "proxy_path": return pt ? "Caminho inválido." : "Invalid path.";
            case "proxy_path_denied": return pt ? "Caminho não permitido." : "Path is not allowed.";
            case "proxy_header": return pt ? "Cabeçalho inválido." : "Invalid header.";
            case "proxy_host": return pt ? "Origem local inválida." : "Invalid local origin.";
            case "proxy_origin": return pt ? "Origem não permitida." : "Origin is not allowed.";
            case "proxy_encoding": return pt ? "Transfer-Encoding não permitido no pedido." : "Transfer-Encoding is not allowed in requests.";
            case "proxy_expect": return pt ? "Expect não permitido." : "Expect is not allowed.";
            case "proxy_size": return pt ? "Tamanho inválido." : "Invalid request size.";
            case "proxy_limit": return pt ? "O envio excede 26 MB." : "The upload exceeds 26 MB.";
            case "proxy_body": return pt ? "Corpo não permitido." : "A request body is not allowed.";
            default: return pt ? "A conexão com o PC está indisponível." : "The PC connection is unavailable.";
        }
    }
}
