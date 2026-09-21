package com.weblens.scan.service;

import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanStatus;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.website.service.WebsiteScanLookup;
import java.util.Collection;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class ScanWebsiteLookup implements WebsiteScanLookup {

    private static final Collection<ScanStatus> ACTIVE_STATUSES = EnumSet.of(
            ScanStatus.QUEUED,
            ScanStatus.RUNNING,
            ScanStatus.CANCEL_REQUESTED
    );

    private final ScanRepository scans;

    public ScanWebsiteLookup(ScanRepository scans) {
        this.scans = scans;
    }

    @Override
    public Map<UUID, LatestScanSummary> findLatest(UUID ownerId, Collection<UUID> websiteIds) {
        if (websiteIds.isEmpty()) {
            return Map.of();
        }
        Map<UUID, LatestScanSummary> latest = new LinkedHashMap<>();
        scans.findLatestByWebsiteIds(ownerId, websiteIds)
                .forEach(scan -> latest.putIfAbsent(scan.getWebsiteId(), summary(scan)));
        return Map.copyOf(latest);
    }

    @Override
    public boolean hasActiveScan(UUID ownerId, UUID websiteId) {
        return scans.existsByWebsiteIdAndRequestedByUserIdAndStatusIn(websiteId, ownerId, ACTIVE_STATUSES);
    }

    private LatestScanSummary summary(ScanEntity scan) {
        return new LatestScanSummary(
                scan.getId(),
                scan.getStatus().name(),
                scan.getCreatedAt(),
                scan.getFinishedAt(),
                scan.progress().processed(),
                scan.progress().failed()
        );
    }
}
