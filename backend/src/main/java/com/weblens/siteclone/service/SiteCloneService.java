package com.weblens.siteclone.service;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.dto.PageResponse;
import com.weblens.common.exception.ApiException;
import com.weblens.common.exception.ConflictException;
import com.weblens.common.exception.NotFoundException;
import com.weblens.messaging.ControlMessagingRepository;
import com.weblens.messaging.contract.MessageEnvelope;
import com.weblens.messaging.contract.SiteCloneCancelPayload;
import com.weblens.scan.service.IdempotencyKeyService;
import com.weblens.scan.service.ScanService;
import com.weblens.siteclone.dto.CreateSiteCloneRequest;
import com.weblens.siteclone.dto.SiteCloneResponse;
import com.weblens.siteclone.dto.SiteCloneProgressResponse;
import com.weblens.siteclone.client.SiteCloneReportClient;
import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.siteclone.entity.SiteCloneRequestEntity;
import com.weblens.siteclone.model.SiteCloneStatus;
import com.weblens.siteclone.repository.SiteCloneRequestRepository;
import com.weblens.website.model.InvalidWebsiteTargetException;
import com.weblens.website.model.WebsiteTarget;
import com.weblens.website.service.WebsiteService;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;
import jakarta.persistence.criteria.Predicate;
import org.springframework.http.HttpStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class SiteCloneService {

    private static final String OPERATION = "create-site-clone-v1";
    private static final int MAX_PAGE_SIZE = 100;

    private final SiteCloneRequestRepository siteClones;
    private final WebsiteService websites;
    private final ScanService scans;
    private final CurrentUserService currentUsers;
    private final IdempotencyKeyService idempotencyKeys;
    private final ControlMessagingRepository messages;
    private final Clock clock;
    private final SiteCloneReportClient reports;

    public SiteCloneService(
            SiteCloneRequestRepository siteClones,
            WebsiteService websites,
            ScanService scans,
            CurrentUserService currentUsers,
            IdempotencyKeyService idempotencyKeys,
            ControlMessagingRepository messages,
            Clock clock,
            SiteCloneReportClient reports
    ) {
        this.siteClones = siteClones;
        this.websites = websites;
        this.scans = scans;
        this.currentUsers = currentUsers;
        this.idempotencyKeys = idempotencyKeys;
        this.messages = messages;
        this.clock = clock;
        this.reports = reports;
    }

    @Transactional
    public CreateResult create(
            UUID ownerId,
            CreateSiteCloneRequest request,
            String rawIdempotencyKey,
            UUID correlationId
    ) {
        currentUsers.lockActive(ownerId);
        WebsiteTarget target = parseTarget(request.url());
        String keyHash = requireIdempotencyKey(rawIdempotencyKey);
        String fingerprint = idempotencyKeys.fingerprint(OPERATION, target.canonicalUrl());
        SiteCloneRequestEntity existing = siteClones.findByOwnerIdAndIdempotencyKeyHash(
                ownerId, keyHash
        ).orElse(null);
        if (existing != null) {
            if (!Objects.equals(existing.getRequestFingerprintHash(), fingerprint)) {
                throw new ConflictException(
                        "IDEMPOTENCY_KEY_REUSED",
                        "The idempotency key was already used for another site-clone URL."
                );
            }
            return new CreateResult(toResponse(existing), true);
        }

        WebsiteService.ResolvedWebsite website = websites.resolveOrCreateForSiteClone(
                ownerId, target.canonicalUrl()
        );
        ScanService.CreateScanResult scan = scans.create(
                ownerId,
                website.id(),
                "site-clone-scan:" + keyHash,
                correlationId
        );
        Instant now = clock.instant();
        SiteCloneRequestEntity siteClone = new SiteCloneRequestEntity(
                UUID.randomUUID(), ownerId, website.id(), scan.response().id(),
                website.canonicalUrl(), keyHash, fingerprint, now
        );
        siteClones.saveAndFlush(siteClone);
        return new CreateResult(toResponse(siteClone), false);
    }

    public SiteCloneResponse get(UUID ownerId, UUID siteCloneId) {
        currentUsers.requireActive(ownerId);
        SiteCloneRequestEntity local = siteClones.findByIdAndOwnerId(siteCloneId, ownerId)
                .orElseThrow(SiteCloneService::notFound);
        if (local.getStatus() == SiteCloneStatus.WAITING_FOR_SCAN) {
            return toResponse(local);
        }
        SiteCloneResponse remote = reports.get(ownerId, siteCloneId);
        return remote == null ? toResponse(local) : remote;
    }

    /**
     * Returns the owner-scoped Control Plane projection. Detail requests remain
     * responsible for fetching the current Capture Worker report, which keeps a
     * bounded list request from turning into one remote request per clone.
     */
    public PageResponse<SiteCloneResponse> list(UUID ownerId, int page, int size, ListFilter filter) {
        currentUsers.requireActive(ownerId);
        if (size < 1 || size > MAX_PAGE_SIZE) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST,
                    "INVALID_PAGE_SIZE",
                    "Invalid page size",
                    "Page size must be between 1 and 100."
            );
        }
        validateRange(filter.createdFrom(), filter.createdTo());
        PageRequest pageable = PageRequest.of(
                page,
                size,
                parseListSort(filter.sort())
        );
        Page<SiteCloneRequestEntity> result = siteClones.findAll(filter(ownerId, filter), pageable);
        return PageResponse.from(result.map(SiteCloneService::toResponse));
    }

    private Specification<SiteCloneRequestEntity> filter(UUID ownerId, ListFilter filter) {
        return (root, query, criteria) -> {
            List<Predicate> predicates = new ArrayList<>();
            predicates.add(criteria.equal(root.get("ownerId"), ownerId));
            if (!filter.statuses().isEmpty()) predicates.add(root.get("status").in(filter.statuses()));
            if (filter.q() != null && !filter.q().isBlank()) {
                String value = filter.q().strip().toLowerCase(Locale.ROOT)
                        .replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
                predicates.add(criteria.like(criteria.lower(root.get("targetUrl")), "%" + value + "%", '\\'));
            }
            if (filter.createdFrom() != null) predicates.add(criteria.greaterThanOrEqualTo(root.get("createdAt"), filter.createdFrom()));
            if (filter.createdTo() != null) predicates.add(criteria.lessThanOrEqualTo(root.get("createdAt"), filter.createdTo()));
            if (filter.terminalCode() != null && !filter.terminalCode().isBlank()) {
                predicates.add(criteria.equal(root.get("terminalCode"), filter.terminalCode().strip()));
            }
            return criteria.and(predicates.toArray(Predicate[]::new));
        };
    }

    private static Sort parseListSort(String rawSort) {
        String[] parts = (rawSort == null ? "createdAt,desc" : rawSort.strip()).split(",", -1);
        if (parts.length != 2 || !List.of("createdAt", "updatedAt", "status", "targetUrl", "processedPages").contains(parts[0])) {
            throw invalidListSort();
        }
        Sort.Direction direction;
        try {
            direction = Sort.Direction.fromString(parts[1]);
        } catch (IllegalArgumentException exception) {
            throw invalidListSort();
        }
        String property = "processedPages".equals(parts[0]) ? "processedCount" : parts[0];
        return Sort.by(direction, property).and(Sort.by(direction, "id"));
    }

    private static void validateRange(Instant from, Instant to) {
        if (from != null && to != null && from.isAfter(to)) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST,
                    "INVALID_DATE_RANGE",
                    "Invalid date range",
                    "The start date must be before or equal to the end date."
            );
        }
    }

    private static ApiException invalidListSort() {
        return new ApiException(
                HttpStatus.BAD_REQUEST,
                "INVALID_SORT",
                "Invalid sort",
                "Sort must use createdAt, updatedAt, status, targetUrl, or processedPages with asc or desc."
        );
    }

    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.NOT_SUPPORTED)
    public SiteCloneProgressResponse getProgress(UUID ownerId, UUID siteCloneId, int after, int limit, String status, String q) {
        currentUsers.requireActive(ownerId);
        SiteCloneRequestEntity local = siteClones.findByIdAndOwnerId(siteCloneId, ownerId)
                .orElseThrow(SiteCloneService::notFound);
        if (local.getStatus() != SiteCloneStatus.WAITING_FOR_SCAN) {
            SiteCloneProgressResponse remote = reports.getProgress(ownerId, siteCloneId, after, limit, status, q);
            if (remote != null) return remote;
        }
        return SiteCloneProgressResponse.pending(siteCloneId, local.getScanId(), local.getStatus().name(), clock.instant());
    }

    public CaptureArtifactContent getArtifact(UUID ownerId, UUID siteCloneId, UUID artifactId) {
        currentUsers.requireActive(ownerId);
        siteClones.findByIdAndOwnerId(siteCloneId, ownerId).orElseThrow(SiteCloneService::notFound);
        return reports.getArtifact(ownerId, siteCloneId, artifactId);
    }

    @Transactional
    public CancelResult cancel(UUID ownerId, UUID siteCloneId, UUID correlationId) {
        currentUsers.requireActive(ownerId);
        SiteCloneRequestEntity snapshot = siteClones.findByIdAndOwnerId(siteCloneId, ownerId)
                .orElseThrow(SiteCloneService::notFound);
        if (snapshot.getStatus() == SiteCloneStatus.WAITING_FOR_SCAN) {
            scans.cancelForSiteClone(ownerId, snapshot.getScanId(), correlationId);
        }
        SiteCloneRequestEntity clone = siteClones.findOwnedForUpdate(siteCloneId, ownerId)
                .orElseThrow(SiteCloneService::notFound);
        SiteCloneStatus previous = clone.getStatus();
        Instant now = clock.instant();
        boolean accepted = clone.requestCancellation(now);
        if (!accepted) {
            return new CancelResult(toResponse(clone), false);
        }
        siteClones.saveAndFlush(clone);
        if (previous != SiteCloneStatus.WAITING_FOR_SCAN) {
            messages.enqueue(new MessageEnvelope<>(
                    UUID.randomUUID(), "SITE_CLONE", clone.getId(), clone.getVersion(),
                    "SITE_CLONE_CANCEL_REQUESTED", 1, correlationId, now,
                    new SiteCloneCancelPayload(clone.getId(), ownerId, now)
            ));
        }
        return new CancelResult(toResponse(clone), true);
    }

    private String requireIdempotencyKey(String raw) {
        String value = idempotencyKeys.hashOptional(raw);
        if (value == null) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST,
                    "IDEMPOTENCY_KEY_REQUIRED",
                    "Idempotency key required",
                    "Idempotency-Key is required for a site-clone request."
            );
        }
        return value;
    }

    private static WebsiteTarget parseTarget(String rawUrl) {
        try {
            return WebsiteTarget.parse(rawUrl);
        } catch (InvalidWebsiteTargetException exception) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST,
                    "INVALID_WEBSITE_URL",
                    "Invalid website URL",
                    exception.getMessage(),
                    exception
            );
        }
    }

    private static SiteCloneResponse toResponse(SiteCloneRequestEntity clone) {
        return new SiteCloneResponse(
                clone.getId(), clone.getWebsiteId(), clone.getScanId(), clone.getTargetUrl(),
                clone.getStatus(), clone.getDiscoveredCount(), clone.getProcessedCount(),
                clone.getSucceededCount(), clone.getFailedCount(), clone.getArtifactCount(),
                clone.getTotalArchiveBytes(), clone.getTerminalCode(), clone.getTerminalMessage(),
                clone.getCreatedAt(), clone.getStartedAt(), clone.getFinishedAt(), java.util.List.of()
        );
    }

    private static NotFoundException notFound() {
        return new NotFoundException("SITE_CLONE_NOT_FOUND", "The site-clone request does not exist.");
    }

    public record CreateResult(SiteCloneResponse response, boolean replayed) {
    }

    public record CancelResult(SiteCloneResponse response, boolean newlyAccepted) {
    }

    public record ListFilter(
            List<SiteCloneStatus> statuses,
            String q,
            Instant createdFrom,
            Instant createdTo,
            String terminalCode,
            String sort
    ) {
        public ListFilter {
            statuses = statuses == null ? List.of() : List.copyOf(statuses);
        }
    }
}
