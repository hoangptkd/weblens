package com.weblens.scan.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;

import com.weblens.auth.entity.UserEntity;
import com.weblens.auth.model.UserStatus;
import com.weblens.common.exception.ConflictException;
import com.weblens.messaging.ControlMessagingRepository;
import com.weblens.messaging.ScanEventService;
import com.weblens.messaging.contract.ScanEventEnvelope;
import com.weblens.messaging.contract.ScanProgressPayload;
import com.weblens.scan.entity.ScanEntity;
import com.weblens.scan.model.ScanConfiguration;
import com.weblens.scan.model.ScanStatus;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.siteclone.entity.SiteCloneRequestEntity;
import com.weblens.siteclone.client.SiteCloneReportClient;
import com.weblens.siteclone.model.SiteCloneStatus;
import com.weblens.siteclone.repository.SiteCloneRequestRepository;
import com.weblens.siteclone.service.SiteCloneService;
import com.weblens.website.entity.WebsiteEntity;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import java.net.URI;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;

// No test-level transaction: assertions read independently committed state.
@SpringBootTest
@ActiveProfiles("test")
@EnabledIf("databaseAvailable")
class ScanCancellationIT {

    private static final String LOCAL_URL = System.getProperty("weblens.test.postgres-url");
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17.6-alpine");

    static boolean databaseAvailable() {
        return LOCAL_URL != null || DockerClientFactory.instance().isDockerAvailable();
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) {
        if (LOCAL_URL != null) {
            URI endpoint = URI.create(LOCAL_URL.substring("jdbc:".length()));
            if (!"127.0.0.1".equals(endpoint.getHost())
                    || !endpoint.getPath().startsWith("/weblens_test_")) {
                throw new IllegalArgumentException("External integration DB must be a loopback weblens_test_* database");
            }
            registry.add("spring.datasource.url", () -> LOCAL_URL);
            registry.add("spring.datasource.username", () -> System.getProperty("weblens.test.postgres-user", "postgres"));
            registry.add("spring.datasource.password", () -> System.getProperty("weblens.test.postgres-password", ""));
        } else {
            POSTGRES.start();
            registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
            registry.add("spring.datasource.username", POSTGRES::getUsername);
            registry.add("spring.datasource.password", POSTGRES::getPassword);
        }
    }

    @AfterAll
    static void stopContainer() {
        if (POSTGRES.isRunning()) POSTGRES.stop();
    }

    @Autowired private ScanService scanService;
    @Autowired private ScanEventService events;
    @Autowired private ScanRepository scans;
    @Autowired private SiteCloneService cloneService;
    @Autowired private SiteCloneRequestRepository clones;
    @Autowired private TransactionTemplate transactions;
    @Autowired private JdbcTemplate jdbc;
    @PersistenceContext private EntityManager entityManager;
    @MockitoSpyBean private ControlMessagingRepository messages;
    @MockitoBean private SiteCloneReportClient cloneReports;

    @Test
    void delayedTerminalEventCommitsAndDuplicateAndOlderEventsCannotUndoIt() {
        ScanEntity scan = fixture();
        scanService.cancel(scan.getRequestedByUserId(), scan.getId(), UUID.randomUUID());
        assertThat(read(scan).getStatus()).isEqualTo(ScanStatus.CANCEL_REQUESTED);
        assertThat(read(scan).getFinishedAt()).isNull();

        ScanEventEnvelope completed = completed(scan);
        assertThat(events.consume(completed).outcome()).isEqualTo("APPLIED");
        assertThat(events.consume(completed).duplicate()).isTrue();
        ScanEventEnvelope older = new ScanEventEnvelope(UUID.randomUUID(), "SCAN", scan.getId(), 2,
                "SCAN_PROGRESS", 1, UUID.randomUUID(), Instant.now().minusSeconds(20),
                new ScanProgressPayload(scan.getId(), scan.getRequestedByUserId(), "RUNNING",
                        1, 1, 0, 0, 0, 0, 0, null, null));
        assertThat(events.consume(older).outcome()).isEqualTo("IGNORED_STALE");

        ScanEntity stored = read(scan);
        assertThat(stored.getStatus()).isEqualTo(ScanStatus.COMPLETED);
        assertThat(stored.getRemoteExecutionVersion()).isEqualTo(3001);
        assertThat(stored.progress().succeeded()).isEqualTo(25);
        assertThat(stored.getAnalyticsStatus()).isEqualTo("READY");
        assertThat(jdbc.queryForObject("select outcome from inbox_messages where message_id = ?",
                String.class, completed.messageId())).isEqualTo("APPLIED");
    }

    @Test
    void concurrentCancellationCommitsExactlyOneCommand() throws Exception {
        ScanEntity scan = fixture();
        race(() -> scanService.cancel(scan.getRequestedByUserId(), scan.getId(), UUID.randomUUID()),
                () -> scanService.cancel(scan.getRequestedByUserId(), scan.getId(), UUID.randomUUID()));
        assertThat(read(scan).getStatus()).isEqualTo(ScanStatus.CANCEL_REQUESTED);
        assertThat(cancelCommands(scan)).isEqualTo(1);
    }

    @Test
    void completionAndCancellationRaceAlwaysPreservesCrawlerCompletion() throws Exception {
        ScanEntity scan = fixture();
        race(() -> {
            try {
                scanService.cancel(scan.getRequestedByUserId(), scan.getId(), UUID.randomUUID());
            } catch (ConflictException alreadyCompleted) {
                assertThat(alreadyCompleted.code()).isEqualTo("SCAN_NOT_CANCELLABLE");
            }
        }, () -> events.consume(completed(scan)));
        assertThat(read(scan).getStatus()).isEqualTo(ScanStatus.COMPLETED);
        assertThat(read(scan).getRemoteExecutionVersion()).isEqualTo(3001);
        assertThat(cancelCommands(scan)).isBetween(0, 1);
    }

    @Test
    void outboxFailureRollsBackCancellationAndItsInsertedCommand() {
        ScanEntity scan = fixture();
        doAnswer(invocation -> {
            invocation.callRealMethod();
            throw new IllegalStateException("test failure after outbox insert");
        }).when(messages).enqueue(any());

        assertThatThrownBy(() -> scanService.cancel(scan.getRequestedByUserId(), scan.getId(), UUID.randomUUID()))
                .hasRootCauseInstanceOf(IllegalStateException.class)
                .hasMessageContaining("test failure after outbox insert");
        assertThat(read(scan).getStatus()).isEqualTo(ScanStatus.QUEUED);
        assertThat(read(scan).getCancellationRequestedAt()).isNull();
        assertThat(cancelCommands(scan)).isZero();
    }

    @Test
    void cancelledWaitingCloneIsNotDispatchedWhenSourceCompletionArrivesLate() {
        ScanEntity scan = fixture();
        UUID cloneId = UUID.randomUUID();
        transactions.executeWithoutResult(tx -> {
            entityManager.persist(new SiteCloneRequestEntity(cloneId, scan.getRequestedByUserId(),
                    scan.getWebsiteId(), scan.getId(), "https://example.com/", "a".repeat(64),
                    "b".repeat(64), Instant.now()));
            entityManager.flush();
        });
        cloneService.cancel(scan.getRequestedByUserId(), cloneId, UUID.randomUUID());
        assertThat(read(scan).getStatus()).isEqualTo(ScanStatus.CANCEL_REQUESTED);
        events.consume(completed(scan));

        assertThat(read(scan).getStatus()).isEqualTo(ScanStatus.COMPLETED);
        assertThat(clones.findById(cloneId).orElseThrow().getStatus()).isEqualTo(SiteCloneStatus.CANCELLED);
        assertThat(jdbc.queryForObject("select count(*) from outbox_events where aggregate_id = ?",
                Integer.class, cloneId)).isZero();
    }

    private ScanEntity fixture() {
        return transactions.execute(tx -> {
            Instant now = Instant.now().minusSeconds(60);
            UUID ownerId = UUID.randomUUID();
            UUID websiteId = UUID.randomUUID();
            String email = ownerId + "@example.com";
            entityManager.persist(new UserEntity(ownerId, email, email, "Test owner",
                    "{bcrypt}test-only", UserStatus.ACTIVE, now, now));
            entityManager.persist(new WebsiteEntity(websiteId, ownerId, "Test website",
                    "https://example.com/", "example.com", now));
            ScanEntity scan = new ScanEntity(UUID.randomUUID(), websiteId, ownerId,
                    new ScanConfiguration(25, 3, 10_485_760, 120, 5, 3), "crawler-v1", null, null, now);
            entityManager.persist(scan);
            entityManager.flush();
            return scan;
        });
    }

    private ScanEntity read(ScanEntity scan) {
        return scans.findById(scan.getId()).orElseThrow();
    }

    private int cancelCommands(ScanEntity scan) {
        return jdbc.queryForObject("select count(*) from outbox_events where aggregate_id = ? and event_type = 'SCAN_CANCEL_REQUESTED'",
                Integer.class, scan.getId());
    }

    private ScanEventEnvelope completed(ScanEntity scan) {
        return new ScanEventEnvelope(UUID.randomUUID(), "SCAN", scan.getId(), 3001,
                "SCAN_PROGRESS", 1, UUID.randomUUID(), Instant.now().minusSeconds(10),
                new ScanProgressPayload(scan.getId(), scan.getRequestedByUserId(), "COMPLETED",
                        25, 0, 25, 25, 0, 25, 25, null, null));
    }

    private void race(Runnable first, Runnable second) throws Exception {
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var one = executor.submit(() -> afterBarrier(first, ready, start));
            var two = executor.submit(() -> afterBarrier(second, ready, start));
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            one.get(15, TimeUnit.SECONDS);
            two.get(15, TimeUnit.SECONDS);
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }

    private void afterBarrier(Runnable action, CountDownLatch ready, CountDownLatch start) {
        ready.countDown();
        try {
            if (!start.await(5, TimeUnit.SECONDS)) throw new AssertionError("Timed out waiting for test barrier");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError(interrupted);
        }
        action.run();
    }
}
