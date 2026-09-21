package com.weblens.dashboard.repository;

import static org.assertj.core.api.Assertions.assertThat;

import com.weblens.auth.entity.UserEntity;
import com.weblens.auth.model.UserStatus;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.model.ScanProgress;
import com.weblens.scan.model.ScanStatus;
import com.weblens.website.entity.WebsiteEntity;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.autoconfigure.orm.jpa.TestEntityManager;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@DataJpaTest
@Import(DashboardSummaryRepository.class)
@ActiveProfiles("test")
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Testcontainers(disabledWithoutDocker = true)
class DashboardSummaryRepositoryIT {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17.6-alpine");

    @Autowired
    private TestEntityManager entityManager;

    @Autowired
    private DashboardSummaryRepository summaries;

    @Test
    void summaryIsOwnerScopedAndUsesPersistedProgress() {
        Instant now = Instant.parse("2026-09-17T08:00:00Z");
        UserEntity owner = owner("owner@example.com", now);
        UserEntity other = owner("other@example.com", now);
        WebsiteEntity activeWebsite = website(owner.getId(), "active.example", now);
        WebsiteEntity archivedWebsite = website(owner.getId(), "archived.example", now);
        WebsiteEntity otherWebsite = website(other.getId(), "other.example", now);
        archivedWebsite.archive(now.plusSeconds(1));

        entityManager.persist(owner);
        entityManager.persist(other);
        entityManager.persist(activeWebsite);
        entityManager.persist(archivedWebsite);
        entityManager.persist(otherWebsite);
        entityManager.persist(completedScan(
                owner.getId(), activeWebsite.getId(), now.minus(2, ChronoUnit.DAYS), 10, 8, 2
        ));
        entityManager.persist(newScan(
                owner.getId(), activeWebsite.getId(), now.minus(1, ChronoUnit.DAYS)
        ));
        entityManager.persist(completedScan(
                owner.getId(), activeWebsite.getId(), now.minus(40, ChronoUnit.DAYS), 4, 4, 0
        ));
        entityManager.persist(completedScan(
                other.getId(), otherWebsite.getId(), now.minus(1, ChronoUnit.DAYS), 7, 7, 0
        ));
        entityManager.flush();
        entityManager.clear();

        var summary = summaries.summarize(owner.getId(), now.minus(30, ChronoUnit.DAYS));

        assertThat(summary.activeWebsites()).isEqualTo(1);
        assertThat(summary.scansLast30Days()).isEqualTo(2);
        assertThat(summary.activeScans()).isEqualTo(1);
        assertThat(summary.processedPages()).isEqualTo(14);
        assertThat(summary.succeededPages()).isEqualTo(12);
        assertThat(summary.failedPages()).isEqualTo(2);
    }

    private UserEntity owner(String email, Instant now) {
        return new UserEntity(
                UUID.randomUUID(), email, email, "Developer", "{bcrypt}test-only-not-a-real-hash",
                UserStatus.ACTIVE, now, now
        );
    }

    private WebsiteEntity website(UUID ownerId, String hostname, Instant now) {
        return new WebsiteEntity(
                UUID.randomUUID(), ownerId, hostname, "https://" + hostname + "/", hostname, now
        );
    }

    private ScanEntity newScan(UUID ownerId, UUID websiteId, Instant createdAt) {
        return new ScanEntity(
                UUID.randomUUID(), websiteId, ownerId,
                new ScanConfiguration(100, 4, 10_485_760, 300, 5, 10),
                "crawler-v1", null, null, createdAt
        );
    }

    private ScanEntity completedScan(
            UUID ownerId,
            UUID websiteId,
            Instant createdAt,
            int processed,
            int succeeded,
            int failed
    ) {
        ScanEntity scan = newScan(ownerId, websiteId, createdAt);
        scan.transitionTo(ScanStatus.RUNNING, createdAt.plusSeconds(1));
        scan.updateProgress(
                new ScanProgress(processed, 0, processed, succeeded, failed, 100),
                createdAt.plusSeconds(2)
        );
        scan.transitionTo(ScanStatus.COMPLETED, createdAt.plusSeconds(3));
        return scan;
    }
}
