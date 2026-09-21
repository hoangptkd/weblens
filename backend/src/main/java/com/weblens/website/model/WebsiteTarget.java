package com.weblens.website.model;

import java.net.IDN;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.util.Locale;

public record WebsiteTarget(String canonicalUrl, String hostname) {

    public static WebsiteTarget parse(String rawUrl) {
        try {
            URI parsed = new URI(rawUrl.strip());
            String scheme = parsed.getScheme() == null ? null : parsed.getScheme().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) {
                throw invalid();
            }
            if (parsed.isOpaque() || parsed.getRawAuthority() == null || parsed.getRawFragment() != null) {
                throw invalid();
            }
            if (parsed.getRawUserInfo() != null || parsed.getRawAuthority().contains("@")) {
                throw invalid();
            }

            HostAndPort hostAndPort = hostAndPort(parsed);
            String asciiHost = IDN.toASCII(hostAndPort.host(), IDN.USE_STD3_ASCII_RULES)
                    .toLowerCase(Locale.ROOT);
            if (asciiHost.isBlank() || isObviouslyNonPublicHostname(asciiHost)) {
                throw invalid();
            }
            int canonicalPort = isDefaultPort(scheme, hostAndPort.port()) ? -1 : hostAndPort.port();
            String path = parsed.getRawPath();
            if (path == null || path.isBlank()) {
                path = "/";
            }
            URI canonical = new URI(
                    scheme,
                    null,
                    asciiHost,
                    canonicalPort,
                    path,
                    parsed.getRawQuery(),
                    null
            ).normalize();
            return new WebsiteTarget(canonical.toASCIIString(), asciiHost);
        } catch (URISyntaxException | IllegalArgumentException | NullPointerException exception) {
            if (exception instanceof InvalidWebsiteTargetException invalidTarget) {
                throw invalidTarget;
            }
            throw invalid();
        }
    }

    private static HostAndPort hostAndPort(URI uri) {
        if (uri.getHost() != null) {
            return new HostAndPort(uri.getHost(), uri.getPort());
        }
        String authority = uri.getRawAuthority();
        if (authority.startsWith("[") || authority.chars().filter(character -> character == ':').count() > 1) {
            throw invalid();
        }
        int separator = authority.lastIndexOf(':');
        if (separator < 0) {
            return new HostAndPort(authority, -1);
        }
        String rawPort = authority.substring(separator + 1);
        if (rawPort.isBlank() || !rawPort.chars().allMatch(Character::isDigit)) {
            throw invalid();
        }
        int port = Integer.parseInt(rawPort);
        if (port < 1 || port > 65_535) {
            throw invalid();
        }
        return new HostAndPort(authority.substring(0, separator), port);
    }

    private static boolean isDefaultPort(String scheme, int port) {
        return ("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443);
    }

    public static boolean isObviouslyNonPublicHostname(String hostname) {
        String normalized = hostname.endsWith(".") ? hostname.substring(0, hostname.length() - 1) : hostname;
        if ("localhost".equals(normalized) || normalized.endsWith(".localhost")) {
            return true;
        }
        if (normalized.isBlank()
                || !normalized.chars().allMatch(character -> Character.isDigit(character) || character == '.')) {
            return false;
        }
        try {
            InetAddress address = InetAddress.getByName(normalized);
            return address.isAnyLocalAddress()
                    || address.isLoopbackAddress()
                    || address.isLinkLocalAddress()
                    || address.isSiteLocalAddress()
                    || address.isMulticastAddress();
        } catch (UnknownHostException exception) {
            return false;
        }
    }

    private static InvalidWebsiteTargetException invalid() {
        return new InvalidWebsiteTargetException();
    }

    private record HostAndPort(String host, int port) {
    }
}
