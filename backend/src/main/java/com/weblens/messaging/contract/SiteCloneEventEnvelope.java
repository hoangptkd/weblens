package com.weblens.messaging.contract;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.time.Instant;
import java.util.UUID;

public record SiteCloneEventEnvelope(
        @NotNull UUID messageId,
        @NotBlank String aggregateType,
        @NotNull UUID aggregateId,
        @Min(1) long aggregateVersion,
        @NotBlank String messageType,
        @Min(1) int contractVersion,
        @NotNull UUID correlationId,
        @NotNull Instant occurredAt,
        @NotNull @Valid SiteCloneProgressPayload payload
) {
}
