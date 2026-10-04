package com.weblens.persistence;

import static org.assertj.core.api.Assertions.assertThat;

import com.weblens.auth.entity.UserEntity;
import com.weblens.auth.model.UserStatus;
import com.weblens.capture.entity.CaptureRequestEntity;
import com.weblens.capture.model.CaptureStatus;
import com.weblens.capture.repository.CaptureRequestRepository;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.website.entity.WebsiteEntity;
import com.weblens.website.model.WebsiteStatus;
import com.weblens.website.repository.WebsiteRepository;
import java.time.Instant;
import java.util.EnumSet;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.autoconfigure.orm.jpa.TestEntityManager;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@DataJpaTest
@ActiveProfiles("test")
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Testcontainers(disabledWithoutDocker = true)
class FoundationPersistenceIT {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17.6-alpine");

    @Autowired
    private TestEntityManager entityManager;

    @Autowired
    private WebsiteRepository websites;

    @Autowired
    private ScanRepository scans;

    @Autowired
    private CaptureRequestRepository captures;

    @Test
    void flywaySchemaSupportsArchiveThenRegisterSameCanonicalUrl() {
        Instant now = Instant.parse("2026-09-09T10:00:00Z");
        UserEntity owner = owner(now);
        WebsiteEntity archived = website(owner.getId(), "First", now);
        entityManager.persist(owner);
        entityManager.persist(archived);
        entityManager.flush();

        archived.archive(now.plusSeconds(1));
        entityManager.flush();
        entityManager.clear();

        WebsiteEntity replacement = website(owner.getId(), "Replacement", now.plusSeconds(2));
        entityManager.persist(replacement);
        entityManager.flush();
        entityManager.clear();

        assertThat(websites.existsByOwnerIdAndCanonicalUrlAndStatus(
                owner.getId(),
                "https://example.com/",
                WebsiteStatus.ACTIVE
        )).isTrue();
        assertThat(websites.count()).isEqualTo(2);
    }

    @Test
    void repositoryQueriesRemainOwnerScopedAndDeterministicallyOrdered() {
        Instant now = Instant.parse("2026-09-09T10:00:00Z");
        UserEntity owner = owner(now);
        WebsiteEntity website = website(owner.getId(), "Target", now);
        entityManager.persist(owner);
        entityManager.persist(website);
        entityManager.persist(completedScan(owner.getId(), website.getId(), now));
        entityManager.persist(completedScan(owner.getId(), website.getId(), now.plusSeconds(1)));
        entityManager.flush();
        entityManager.clear();

        var page = scans.findAllByWebsiteIdAndRequestedByUserId(
                website.getId(),
                owner.getId(),
                PageRequest.of(0, 20, Sort.by(Sort.Direction.DESC, "createdAt"))
        );

        assertThat(page.getTotalElements()).isEqualTo(2);
        assertThat(page.getContent()).extracting(ScanEntity::getCreatedAt)
                .containsExactly(now.plusSeconds(1), now);
        assertThat(scans.findAllByWebsiteIdAndRequestedByUserId(
                website.getId(),
                UUID.randomUUID(),
                PageRequest.of(0, 20)
        )).isEmpty();
    }

    @Test
    void flywaySchemaAcceptsExperimentalScanHardCaps() {
        Instant now = Instant.parse("2026-09-12T10:00:00Z");
        UserEntity owner = owner(now);
        WebsiteEntity website = website(owner.getId(), "Load target", now);
        entityManager.persist(owner);
        entityManager.persist(website);
        entityManager.persist(new ScanEntity(
                UUID.randomUUID(),
                website.getId(),
                owner.getId(),
                new ScanConfiguration(1_000_000, 10, 52_428_800, 604_800, 10, 10_000),
                "crawler-v1",
                null,
                null,
                now
        ));
        entityManager.flush();
        entityManager.clear();

        ScanEntity persisted = scans.findAllByWebsiteIdAndRequestedByUserId(
                website.getId(),
                owner.getId(),
                PageRequest.of(0, 1)
        ).getContent().getFirst();
        assertThat(persisted.getMaxPages()).isEqualTo(1_000_000);
        assertThat(persisted.getMaxDurationSeconds()).isEqualTo(604_800);
        assertThat(persisted.getConcurrency()).isEqualTo(10_000);
    }

    @Test
    void latestReadyCaptureQueryIsOwnerScopedAndDeterministicallyOrdered() {
        Instant now = Instant.parse("2026-09-13T06:00:00Z");
        UserEntity owner = owner(now);
        WebsiteEntity website = website(owner.getId(), "Capture target", now);
        ScanEntity scan = scan(owner.getId(), website.getId(), now);
        UUID pageId = UUID.randomUUID();
        CaptureRequestEntity older = completedCapture(
                owner.getId(), scan.getId(), pageId, now.plusSeconds(1)
        );
        CaptureRequestEntity latest = completedCapture(
                owner.getId(), scan.getId(), pageId, now.plusSeconds(2)
        );
        entityManager.persist(owner);
        entityManager.persist(website);
        entityManager.persist(scan);
        entityManager.persist(older);
        entityManager.persist(latest);
        entityManager.flush();
        entityManager.clear();

        var readyStatuses = EnumSet.of(CaptureStatus.COMPLETED, CaptureStatus.PARTIAL_SUCCESS);
        assertThat(captures.findFirstByOwnerIdAndScanIdAndPageIdAndStatusInOrderByCreatedAtDescIdDesc(
                owner.getId(), scan.getId(), pageId, readyStatuses
        )).get().extracting(CaptureRequestEntity::getId).isEqualTo(latest.getId());
        assertThat(captures.findFirstByOwnerIdAndScanIdAndPageIdAndStatusInOrderByCreatedAtDescIdDesc(
                UUID.randomUUID(), scan.getId(), pageId, readyStatuses
        )).isEmpty();
    }

    private UserEntity owner(Instant now) {
        return new UserEntity(
                UUID.randomUUID(),
                "developer@example.com",
                "developer@example.com",
                "Developer",
                "{bcrypt}test-only-not-a-real-hash",
                UserStatus.ACTIVE,
                now,
                now
        );
    }

    private WebsiteEntity website(UUID ownerId, String name, Instant now) {
        return new WebsiteEntity(
                UUID.randomUUID(),
                ownerId,
                name,
                "https://example.com/",
                "example.com",
                now
        );
    }

    private ScanEntity scan(UUID ownerId, UUID websiteId, Instant now) {
        return new ScanEntity(
                UUID.randomUUID(),
                websiteId,
                ownerId,
                new ScanConfiguration(25, 3, 10_485_760, 120, 5, 3),
                "crawler-v1",
                null,
                null,
                now
        );
    }

    private ScanEntity completedScan(UUID ownerId, UUID websiteId, Instant createdAt) {
        ScanEntity scan = scan(ownerId, websiteId, createdAt);
        scan.requestCancellation(createdAt.plusMillis(1));
        scan.transitionTo(com.weblens.scan.model.ScanStatus.CANCELLED, createdAt.plusMillis(2));
        return scan;
    }

    private CaptureRequestEntity completedCapture(UUID ownerId, UUID scanId, UUID pageId, Instant createdAt) {
        CaptureRequestEntity capture = new CaptureRequestEntity(
                UUID.randomUUID(), ownerId, scanId, pageId, "https://example.com/", null, null, createdAt
        );
        capture.applyRemote(
                1, CaptureStatus.COMPLETED.name(), 1, 1, 2, 17_739,
                null, null, createdAt.plusSeconds(1)
        );
        return capture;
    }
}
