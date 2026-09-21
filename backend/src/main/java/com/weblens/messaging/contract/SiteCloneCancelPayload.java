package com.weblens.messaging.contract;

import java.time.Instant;
import java.util.UUID;

public record SiteCloneCancelPayload(
        UUID siteCloneRequestId,
        UUID ownerId,
        Instant requestedAt
) {
}
