package com.weblens.common.config;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties("weblens.capture")
public record CaptureProperties(
        @NotNull URI commandUrl,
        @NotNull URI siteCloneCommandUrl,
        @NotNull URI reportBaseUrl,
        @NotBlank @Size(min = 32, max = 512) String serviceToken,
        @NotNull Duration connectTimeout,
        @NotNull Duration readTimeout,
        @NotNull Duration browserSessionReadTimeout,
        @NotNull Duration outboxLease
) {
    public CaptureProperties {
        requireHttpUrl(commandUrl, "commandUrl");
        requireHttpUrl(siteCloneCommandUrl, "siteCloneCommandUrl");
        requireHttpUrl(reportBaseUrl, "reportBaseUrl");
        requireRange(connectTimeout, Duration.ofMillis(100), Duration.ofSeconds(30), "connectTimeout");
        requireRange(readTimeout, Duration.ofMillis(100), Duration.ofMinutes(1), "readTimeout");
        requireRange(browserSessionReadTimeout, Duration.ofSeconds(1), Duration.ofMinutes(1), "browserSessionReadTimeout");
        requireRange(outboxLease, Duration.ofSeconds(5), Duration.ofMinutes(5), "outboxLease");
    }

    private static void requireHttpUrl(URI value, String name) {
        if (value != null && (!value.isAbsolute()
                || !("http".equalsIgnoreCase(value.getScheme()) || "https".equalsIgnoreCase(value.getScheme()))
                || value.getUserInfo() != null)) {
            throw new IllegalArgumentException(name + " must be an absolute HTTP(S) URL without userinfo");
        }
    }

    private static void requireRange(Duration value, Duration minimum, Duration maximum, String name) {
        if (value != null && (value.compareTo(minimum) < 0 || value.compareTo(maximum) > 0)) {
            throw new IllegalArgumentException(name + " is outside the supported range");
        }
    }
}
