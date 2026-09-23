package com.weblens.siteclone.dto;

import java.time.Instant;

public record SiteCloneBrowserSessionResponse(
        String status,
        String currentUrl,
        Instant expiresAt,
        int viewportWidth,
        int viewportHeight
) {
}
