package com.weblens.scan.service;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.config.ScanLimitProperties;
import com.weblens.common.dto.PageResponse;
import com.weblens.common.exception.ConflictException;
import com.weblens.common.exception.NotFoundException;
import com.weblens.messaging.ControlMessagingRepository;
import com.weblens.messaging.contract.MessageEnvelope;
import com.weblens.messaging.contract.ScanRequestedPayload;
import com.weblens.messaging.contract.ScanCancelPayload;
import com.weblens.scan.dto.EffectiveScanConfigResponse;
import com.weblens.scan.dto.ScanProgressResponse;
import com.weblens.scan.dto.ScanResponse;
import com.weblens.scan.dto.TerminalReasonResponse;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.model.ScanNotCancellableException;
import com.weblens.scan.model.ScanStatus;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.website.model.WebsiteTarget;
import com.weblens.website.service.WebsiteAccessService;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.EnumSet;
import jakarta.persistence.criteria.Predicate;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class ScanService {

    private static final int MAX_PAGE_SIZE = 100;
    private static final int MAX_ACTIVE_SCANS_PER_USER = 3;
    private static final EnumSet<ScanStatus> ACTIVE_STATUSES = EnumSet.of(
            ScanStatus.QUEUED, ScanStatus.RUNNING, ScanStatus.CANCEL_REQUESTED
    );
    private static final String CREATE_OPERATION = "create-scan-v1";
    private static final String COLLECTOR_VERSION = "crawler-v1";

    private final ScanRepository scans;
    private final WebsiteAccessService websiteAccess;
    private final CurrentUserService currentUsers;
    private final ScanLimitProperties limits;
    private final IdempotencyKeyService idempotencyKeys;
    private final ControlMessagingRepository messages;
    private final Clock clock;

    public ScanService(
            ScanRepository scans,
            WebsiteAccessService websiteAccess,
            CurrentUserService currentUsers,
            ScanLimitProperties limits,
            IdempotencyKeyService idempotencyKeys,
            ControlMessagingRepository messages,
            Clock clock
    ) {
        this.scans = scans;
        this.websiteAccess = websiteAccess;
        this.currentUsers = currentUsers;
        this.limits = limits;
        this.idempotencyKeys = idempotencyKeys;
        this.messages = messages;
        this.clock = clock;
    }

    @Transactional
    public CreateScanResult create(
            UUID userId,
            UUID websiteId,
            String rawIdempotencyKey,
            UUID correlationId
    ) {
        currentUsers.lockActive(userId);
        WebsiteAccessService.WebsiteTargetSnapshot website = websiteAccess.lockOwnedActive(userId, websiteId);
        requirePublicTarget(website.hostname());

        String keyHash = idempotencyKeys.hashOptional(rawIdempotencyKey);
        String fingerprint = keyHash == null
                ? null
                : idempotencyKeys.fingerprint(CREATE_OPERATION, websiteId.toString());
        if (keyHash != null) {
            ScanEntity existing = scans.findByRequestedByUserIdAndIdempotencyKeyHash(userId, keyHash).orElse(null);
            if (existing != null) {
                return replay(existing, fingerprint);
            }
        }

        if (scans.existsByWebsiteIdAndRequestedByUserIdAndStatusIn(
                websiteId, userId, ACTIVE_STATUSES
        )) {
            throw new ConflictException(
                    "WEBSITE_SCAN_ALREADY_ACTIVE",
                    "The website already has an active scan."
            );
        }
        if (scans.countByRequestedByUserIdAndStatusIn(userId, ACTIVE_STATUSES)
                >= MAX_ACTIVE_SCANS_PER_USER) {
            throw new ConflictException(
                    "ACTIVE_SCAN_QUOTA_EXCEEDED",
                    "A user can run at most three scans at the same time."
            );
        }

        Instant now = clock.instant();
        ScanEntity scan = new ScanEntity(
                UUID.randomUUID(),
                websiteId,
                userId,
                configuration(),
                COLLECTOR_VERSION,
                keyHash,
                fingerprint,
                now
        );
        scans.saveAndFlush(scan);
		messages.enqueue(new MessageEnvelope<>(
				UUID.randomUUID(),
				"SCAN",
				scan.getId(),
				scan.getVersion(),
				"SCAN_REQUESTED",
				1,
				correlationId,
				now,
				new ScanRequestedPayload(
						scan.getId(), userId, website.websiteId(), website.canonicalUrl(), website.hostname(),
						scan.getMaxPages(), scan.getMaxDepth(), scan.getMaxResponseBytes(),
						scan.getMaxDurationSeconds(), scan.getMaxRedirects(), scan.getConcurrency(),
						scan.getCollectorVersion()
				)
		));
        return new CreateScanResult(toResponse(scan), false);
    }

    public PageResponse<ScanResponse> list(
            UUID userId,
            UUID websiteId,
            int page,
            int size,
            ListFilter filter
    ) {
        currentUsers.requireActive(userId);
        websiteAccess.requireOwnedActive(userId, websiteId);
        validateRange(filter.createdFrom(), filter.createdTo());
        PageRequest pageable = PageRequest.of(
                page,
                boundedSize(size),
                parseListSort(filter.sort())
        );
        Page<ScanEntity> result = scans.findAll(filter(userId, websiteId, filter), pageable);
        return PageResponse.from(result.map(this::toResponse));
    }

    private Specification<ScanEntity> filter(UUID userId, UUID websiteId, ListFilter filter) {
        return (root, query, criteria) -> {
            List<Predicate> predicates = new ArrayList<>();
            predicates.add(criteria.equal(root.get("requestedByUserId"), userId));
            predicates.add(criteria.equal(root.get("websiteId"), websiteId));
            if (!filter.statuses().isEmpty()) predicates.add(root.get("status").in(filter.statuses()));
            if (filter.createdFrom() != null) predicates.add(criteria.greaterThanOrEqualTo(root.get("createdAt"), filter.createdFrom()));
            if (filter.createdTo() != null) predicates.add(criteria.lessThanOrEqualTo(root.get("createdAt"), filter.createdTo()));
            if (filter.terminalCode() != null && !filter.terminalCode().isBlank()) {
                predicates.add(criteria.equal(root.get("terminalCode"), filter.terminalCode().strip()));
            }
            if (filter.minFailedPages() != null) {
                predicates.add(criteria.greaterThanOrEqualTo(root.get("failedCount"), filter.minFailedPages()));
            }
            return criteria.and(predicates.toArray(Predicate[]::new));
        };
    }

    private Sort parseListSort(String rawSort) {
        String[] parts = (rawSort == null ? "createdAt,desc" : rawSort.strip()).split(",", -1);
        if (parts.length != 2 || !List.of("createdAt", "updatedAt", "status", "failedPages").contains(parts[0])) {
            throw invalidListSort();
        }
        Sort.Direction direction;
        try {
            direction = Sort.Direction.fromString(parts[1]);
        } catch (IllegalArgumentException exception) {
            throw invalidListSort();
        }
        String property = "failedPages".equals(parts[0]) ? "failedCount" : parts[0];
        return Sort.by(direction, property).and(Sort.by(direction, "id"));
    }

    private static void validateRange(Instant from, Instant to) {
        if (from != null && to != null && from.isAfter(to)) {
            throw new com.weblens.common.exception.ApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_DATE_RANGE",
                    "Invalid date range",
                    "The start date must be before or equal to the end date."
            );
        }
    }

    private static com.weblens.common.exception.ApiException invalidListSort() {
        return new com.weblens.common.exception.ApiException(
                org.springframework.http.HttpStatus.BAD_REQUEST,
                "INVALID_SORT",
                "Invalid sort",
                "Sort must use createdAt, updatedAt, status, or failedPages with asc or desc."
        );
    }

    public ScanResponse get(UUID userId, UUID scanId) {
        currentUsers.requireActive(userId);
        return toResponse(scans.findByIdAndRequestedByUserId(scanId, userId).orElseThrow(ScanService::notFound));
    }

    @Transactional
    public CancelScanResult cancel(UUID userId, UUID scanId, UUID correlationId) {
        currentUsers.requireActive(userId);
        ScanEntity scan = scans.findByIdAndRequestedByUserIdForUpdate(scanId, userId)
                .orElseThrow(ScanService::notFound);
        try {
			Instant now = clock.instant();
            boolean newlyAccepted = scan.requestCancellation(now);
			if (newlyAccepted) {
				scans.saveAndFlush(scan);
				messages.enqueue(new MessageEnvelope<>(
						UUID.randomUUID(), "SCAN", scan.getId(), scan.getVersion(),
						"SCAN_CANCEL_REQUESTED", 1, correlationId, now,
						new ScanCancelPayload(scan.getId(), userId, now)
				));
			}
            return new CancelScanResult(toResponse(scan), newlyAccepted);
        } catch (ScanNotCancellableException exception) {
            throw new ConflictException("SCAN_NOT_CANCELLABLE", exception.getMessage());
        }
    }

    /**
     * Cancels the source scan for a site-clone while preserving the global lock
     * order: scan row first, site-clone row second. A terminal scan is a normal
     * race here because its event may already be waiting to dispatch the clone.
     */
    @Transactional
    public void cancelForSiteClone(UUID userId, UUID scanId, UUID correlationId) {
        currentUsers.requireActive(userId);
        ScanEntity scan = scans.findByIdAndRequestedByUserIdForUpdate(scanId, userId)
                .orElseThrow(ScanService::notFound);
        try {
            Instant now = clock.instant();
            if (scan.requestCancellation(now)) {
                scans.saveAndFlush(scan);
                messages.enqueue(new MessageEnvelope<>(
                        UUID.randomUUID(), "SCAN", scan.getId(), scan.getVersion(),
                        "SCAN_CANCEL_REQUESTED", 1, correlationId, now,
                        new ScanCancelPayload(scan.getId(), userId, now)
                ));
            }
        } catch (ScanNotCancellableException ignored) {
            // The scan event path will lock the site-clone row next. The caller
            // continues with that same order and cancels the resulting clone.
        }
    }

    private CreateScanResult replay(ScanEntity existing, String expectedFingerprint) {
        if (!java.util.Objects.equals(existing.getRequestFingerprintHash(), expectedFingerprint)) {
            throw new ConflictException(
                    "IDEMPOTENCY_KEY_REUSED",
                    "The idempotency key was already used for a different scan request."
            );
        }
        return new CreateScanResult(toResponse(existing), true);
    }

    private ScanResponse toResponse(ScanEntity scan) {
        Long durationMs = durationMs(scan);
        TerminalReasonResponse terminalReason = scan.getTerminalCode() == null
                ? null
                : new TerminalReasonResponse(scan.getTerminalCode(), scan.getTerminalMessage());
        return new ScanResponse(
                scan.getId(),
                scan.getWebsiteId(),
                scan.getStatus(),
                scan.getCreatedAt(),
                scan.getStartedAt(),
                scan.getFinishedAt(),
                durationMs,
                new ScanProgressResponse(
                        scan.progress().discovered(),
                        scan.progress().queued(),
                        scan.progress().processed(),
                        scan.progress().succeeded(),
                        scan.progress().failed(),
                        scan.progress().limit()
                ),
                new EffectiveScanConfigResponse(
                        scan.getMaxPages(),
                        scan.getMaxDepth(),
                        scan.getMaxResponseBytes(),
                        scan.getMaxDurationSeconds(),
                        scan.getMaxRedirects(),
                        scan.getConcurrency()
                ),
                scan.getCollectorVersion(),
                terminalReason
        );
    }

    private Long durationMs(ScanEntity scan) {
        if (scan.getStartedAt() == null) {
            return null;
        }
        Instant end = scan.getFinishedAt() == null ? clock.instant() : scan.getFinishedAt();
        return Math.max(0, Duration.between(scan.getStartedAt(), end).toMillis());
    }

    private ScanConfiguration configuration() {
        return new ScanConfiguration(
                limits.maxPages(),
                limits.maxDepth(),
                limits.maxResponseBytes(),
                limits.maxDurationSeconds(),
                limits.maxRedirects(),
                limits.concurrency()
        );
    }

    private int boundedSize(int size) {
        if (size < 1 || size > MAX_PAGE_SIZE) {
            throw new com.weblens.common.exception.ApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_PAGE_SIZE",
                    "Invalid page size",
                    "Page size must be between 1 and 100."
            );
        }
        return size;
    }

    private static NotFoundException notFound() {
        return new NotFoundException("SCAN_NOT_FOUND", "The scan does not exist.");
    }

    private static void requirePublicTarget(String hostname) {
        if (WebsiteTarget.isObviouslyNonPublicHostname(hostname)) {
            throw new com.weblens.common.exception.ApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "UNSAFE_SCAN_TARGET",
                    "Unsafe scan target",
                    "The website target must use a public network address."
            );
        }
    }

    public record CreateScanResult(ScanResponse response, boolean replayed) {
    }

    public record CancelScanResult(ScanResponse response, boolean newlyAccepted) {
    }

    public record ListFilter(
            List<ScanStatus> statuses,
            Instant createdFrom,
            Instant createdTo,
            String terminalCode,
            Integer minFailedPages,
            String sort
    ) {
        public ListFilter {
            statuses = statuses == null ? List.of() : List.copyOf(statuses);
        }
    }
}
