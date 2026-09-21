package com.weblens.siteclone.service;

import com.weblens.common.config.SiteCloneProperties;
import com.weblens.messaging.ControlMessagingRepository;
import com.weblens.messaging.contract.MessageEnvelope;
import com.weblens.messaging.contract.SiteCloneRequestedPayload;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanStatus;
import com.weblens.siteclone.entity.SiteCloneRequestEntity;
import com.weblens.siteclone.repository.SiteCloneRequestRepository;
import java.time.Instant;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class SiteCloneScanCoordinator {

    private final SiteCloneRequestRepository siteClones;
    private final ControlMessagingRepository messages;
    private final SiteCloneProperties properties;

    public SiteCloneScanCoordinator(
            SiteCloneRequestRepository siteClones,
            ControlMessagingRepository messages,
            SiteCloneProperties properties
    ) {
        this.siteClones = siteClones;
        this.messages = messages;
        this.properties = properties;
    }

    public void onScanProjectionApplied(ScanEntity scan, UUID correlationId, Instant now) {
        if (!scan.getStatus().isTerminal()) {
            return;
        }
        SiteCloneRequestEntity clone = siteClones.findByScanIdForUpdate(scan.getId()).orElse(null);
        if (clone == null) {
            return;
        }
        if ((scan.getStatus() == ScanStatus.COMPLETED || scan.getStatus() == ScanStatus.PARTIAL_SUCCESS)
                && scan.progress().succeeded() > 0) {
            if (!clone.markReadyForDispatch(now)) {
                return;
            }
            siteClones.saveAndFlush(clone);
            messages.enqueue(new MessageEnvelope<>(
                    UUID.randomUUID(), "SITE_CLONE", clone.getId(), clone.getVersion(),
                    "SITE_CLONE_REQUESTED", 1, correlationId, now,
                    new SiteCloneRequestedPayload(
                            clone.getId(), clone.getOwnerId(), clone.getScanId(), clone.getTargetUrl(),
                            Math.min(scan.getMaxPages(), properties.maxPages()),
                            properties.maxInputBytes(), properties.maxArchiveBytes(),
                            properties.maxShardBytes(), properties.pageConcurrency(),
                            properties.maxRetriesPerPage(), properties.maxDurationSeconds(),
                            properties.archiveRetentionDays(), properties.metadataRetentionDays(), true
                    )
            ));
            return;
        }
        clone.failFromScan(
                "SOURCE_SCAN_NOT_CLONEABLE",
                "The automatically created scan did not produce a successful page.",
                now
        );
    }
}
