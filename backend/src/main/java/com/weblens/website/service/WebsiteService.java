package com.weblens.website.service;

import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.dto.PageResponse;
import com.weblens.common.exception.ConflictException;
import com.weblens.website.dto.CreateWebsiteRequest;
import com.weblens.website.dto.LatestScanResponse;
import com.weblens.website.dto.UpdateWebsiteRequest;
import com.weblens.website.dto.WebsiteResponse;
import com.weblens.website.entity.WebsiteEntity;
import com.weblens.website.model.WebsiteStatus;
import com.weblens.website.model.InvalidWebsiteTargetException;
import com.weblens.website.model.WebsiteTarget;
import com.weblens.website.repository.WebsiteRepository;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanStatus;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import jakarta.persistence.criteria.Predicate;
import jakarta.persistence.criteria.Root;
import jakarta.persistence.criteria.Subquery;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class WebsiteService {

    private static final int MAX_PAGE_SIZE = 100;

    private final WebsiteRepository websites;
    private final WebsiteScanLookup scans;
    private final CurrentUserService currentUsers;
    private final Clock clock;

    public WebsiteService(
            WebsiteRepository websites,
            WebsiteScanLookup scans,
            CurrentUserService currentUsers,
            Clock clock
    ) {
        this.websites = websites;
        this.scans = scans;
        this.currentUsers = currentUsers;
        this.clock = clock;
    }

    @Transactional
    public WebsiteResponse create(UUID ownerId, CreateWebsiteRequest request) {
        currentUsers.requireActive(ownerId);
        WebsiteTarget target = parseTarget(request.url());
        if (websites.existsByOwnerIdAndCanonicalUrlAndStatus(ownerId, target.canonicalUrl(), WebsiteStatus.ACTIVE)) {
            throw duplicateWebsite();
        }
        Instant now = clock.instant();
        WebsiteEntity website = new WebsiteEntity(
                UUID.randomUUID(),
                ownerId,
                request.name().strip(),
                target.canonicalUrl(),
                target.hostname(),
                now
        );
        try {
            websites.saveAndFlush(website);
        } catch (DataIntegrityViolationException exception) {
            throw duplicateWebsite();
        }
        return toResponse(website, null);
    }

    /**
     * Application boundary used by the site-clone orchestration. Resolving the
     * owner-scoped registration and creating it on demand happen in the caller's
     * transaction; no network fetch is performed here.
     */
    @Transactional
    public ResolvedWebsite resolveOrCreateForSiteClone(UUID ownerId, String rawUrl) {
        currentUsers.requireActive(ownerId);
        WebsiteTarget target = parseTarget(rawUrl);
        WebsiteEntity existing = websites.findByOwnerIdAndCanonicalUrlAndStatus(
                ownerId, target.canonicalUrl(), WebsiteStatus.ACTIVE
        ).orElse(null);
        if (existing != null) {
            return resolved(existing, false);
        }

        Instant now = clock.instant();
        WebsiteEntity created = new WebsiteEntity(
                UUID.randomUUID(), ownerId, target.hostname(), target.canonicalUrl(), target.hostname(), now
        );
        websites.saveAndFlush(created);
        return resolved(created, true);
    }

    public PageResponse<WebsiteResponse> list(
            UUID ownerId,
            int page,
            int size,
            ListFilter filter
    ) {
        currentUsers.requireActive(ownerId);
        validateRange(filter.createdFrom(), filter.createdTo());
        validateRange(filter.updatedFrom(), filter.updatedTo());
        PageRequest pageable = PageRequest.of(page, boundedSize(size), parseSort(filter.sort()));
        Page<WebsiteEntity> result = websites.findAll(filter(ownerId, filter), pageable);
        Map<UUID, WebsiteScanLookup.LatestScanSummary> latest = scans.findLatest(
                ownerId,
                result.getContent().stream().map(WebsiteEntity::getId).toList()
        );
        return PageResponse.from(result.map(website -> toResponse(website, latest.get(website.getId()))));
    }

    public WebsiteResponse get(UUID ownerId, UUID websiteId) {
        currentUsers.requireActive(ownerId);
        WebsiteEntity website = websites.findByIdAndOwnerId(websiteId, ownerId)
                .orElseThrow(WebsiteAccessService::notFound);
        WebsiteScanLookup.LatestScanSummary latest = scans.findLatest(ownerId, List.of(websiteId)).get(websiteId);
        return toResponse(website, latest);
    }

    @Transactional
    public WebsiteResponse rename(UUID ownerId, UUID websiteId, UpdateWebsiteRequest request) {
        currentUsers.requireActive(ownerId);
        WebsiteEntity website = websites.findByIdAndOwnerId(websiteId, ownerId)
                .orElseThrow(WebsiteAccessService::notFound);
        website.rename(request.name().strip(), clock.instant());
        WebsiteScanLookup.LatestScanSummary latest = scans.findLatest(ownerId, List.of(websiteId)).get(websiteId);
        return toResponse(website, latest);
    }

    @Transactional
    public void archive(UUID ownerId, UUID websiteId) {
        currentUsers.requireActive(ownerId);
        WebsiteEntity website = websites.findForUpdate(websiteId, ownerId, WebsiteStatus.ACTIVE)
                .orElseThrow(WebsiteAccessService::notFound);
        if (scans.hasActiveScan(ownerId, websiteId)) {
            throw new ConflictException(
                    "WEBSITE_HAS_ACTIVE_SCAN",
                    "The website cannot be archived while a scan is active."
            );
        }
        website.archive(clock.instant());
    }

    private WebsiteResponse toResponse(
            WebsiteEntity website,
            WebsiteScanLookup.LatestScanSummary latest
    ) {
        LatestScanResponse latestResponse = latest == null ? null : new LatestScanResponse(
                latest.id(), latest.status(), latest.createdAt(), latest.finishedAt(),
                latest.processedPages(), latest.failedPages()
        );
        return new WebsiteResponse(
                website.getId(),
                website.getDisplayName(),
                website.getCanonicalUrl(),
                website.getHostname(),
                website.getStatus(),
                latestResponse,
                latest == null ? 0 : latest.processedPages(),
                latest == null ? 0 : latest.failedPages(),
                website.getCreatedAt(),
                website.getUpdatedAt()
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

    private Sort parseSort(String rawSort) {
        String normalized = rawSort == null ? "updatedAt,desc" : rawSort.strip();
        String[] parts = normalized.split(",", -1);
        if (parts.length != 2 || !List.of("updatedAt", "createdAt", "name").contains(parts[0])) {
            throw invalidSort();
        }
        Sort.Direction direction;
        try {
            direction = Sort.Direction.fromString(parts[1]);
        } catch (IllegalArgumentException exception) {
            throw invalidSort();
        }
        String property = "name".equals(parts[0]) ? "displayName" : parts[0];
        return Sort.by(direction, property).and(Sort.by(Sort.Direction.ASC, "id"));
    }

    private Specification<WebsiteEntity> filter(UUID ownerId, ListFilter filter) {
        return (root, query, criteria) -> {
            List<Predicate> predicates = new ArrayList<>();
            predicates.add(criteria.equal(root.get("ownerId"), ownerId));
            if (!filter.statuses().isEmpty()) predicates.add(root.get("status").in(filter.statuses()));
            String search = normalized(filter.q());
            if (search != null) {
                String pattern = containsPattern(search);
                predicates.add(criteria.or(
                        criteria.like(criteria.lower(root.get("displayName")), pattern, '\\'),
                        criteria.like(criteria.lower(root.get("hostname")), pattern, '\\'),
                        criteria.like(criteria.lower(root.get("canonicalUrl")), pattern, '\\')
                ));
            }
            String hostname = normalized(filter.hostname());
            if (hostname != null) predicates.add(criteria.equal(criteria.lower(root.get("hostname")), hostname));
            if (filter.createdFrom() != null) predicates.add(criteria.greaterThanOrEqualTo(root.get("createdAt"), filter.createdFrom()));
            if (filter.createdTo() != null) predicates.add(criteria.lessThanOrEqualTo(root.get("createdAt"), filter.createdTo()));
            if (filter.updatedFrom() != null) predicates.add(criteria.greaterThanOrEqualTo(root.get("updatedAt"), filter.updatedFrom()));
            if (filter.updatedTo() != null) predicates.add(criteria.lessThanOrEqualTo(root.get("updatedAt"), filter.updatedTo()));
            if (filter.hasActiveScan() != null) {
                Subquery<Integer> activeQuery = query.subquery(Integer.class);
                Root<ScanEntity> scan = activeQuery.from(ScanEntity.class);
                activeQuery.select(criteria.literal(1)).where(
                        criteria.equal(scan.get("websiteId"), root.get("id")),
                        criteria.equal(scan.get("requestedByUserId"), ownerId),
                        scan.get("status").in(List.of(
                                ScanStatus.QUEUED, ScanStatus.RUNNING, ScanStatus.CANCEL_REQUESTED
                        ))
                );
                Predicate active = criteria.exists(activeQuery);
                predicates.add(filter.hasActiveScan() ? active : criteria.not(active));
            }
            return criteria.and(predicates.toArray(Predicate[]::new));
        };
    }

    private static String normalized(String value) {
        if (value == null || value.isBlank()) return null;
        return value.strip().toLowerCase(Locale.ROOT);
    }

    private static String containsPattern(String value) {
        return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
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

    private com.weblens.common.exception.ApiException invalidSort() {
        return new com.weblens.common.exception.ApiException(
                org.springframework.http.HttpStatus.BAD_REQUEST,
                "INVALID_SORT",
                "Invalid sort",
                "Sort must use updatedAt, createdAt, or name with asc or desc."
        );
    }

    private ConflictException duplicateWebsite() {
        return new ConflictException("WEBSITE_ALREADY_REGISTERED", "This website is already registered.");
    }

    private WebsiteTarget parseTarget(String rawUrl) {
        try {
            return WebsiteTarget.parse(rawUrl);
        } catch (InvalidWebsiteTargetException exception) {
            throw new com.weblens.common.exception.ApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_WEBSITE_URL",
                    "Invalid website URL",
                    exception.getMessage(),
                    exception
            );
        }
    }

    private static ResolvedWebsite resolved(WebsiteEntity website, boolean created) {
        return new ResolvedWebsite(
                website.getId(), website.getCanonicalUrl(), website.getHostname(), created
        );
    }

    public record ResolvedWebsite(
            UUID id,
            String canonicalUrl,
            String hostname,
            boolean created
    ) {
    }

    public record ListFilter(
            List<WebsiteStatus> statuses,
            String q,
            String hostname,
            Instant createdFrom,
            Instant createdTo,
            Instant updatedFrom,
            Instant updatedTo,
            Boolean hasActiveScan,
            String sort
    ) {
        public ListFilter {
            statuses = statuses == null ? List.of() : List.copyOf(statuses);
        }
    }
}
