package com.weblens.scan.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.BDDMockito.given;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.weblens.auth.service.CurrentUserService;
import com.weblens.common.config.ScanLimitProperties;
import com.weblens.messaging.ControlMessagingRepository;
import com.weblens.scan.repository.ScanRepository;
import com.weblens.website.service.WebsiteAccessService;
import java.time.Clock;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionSystemException;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.springframework.transaction.support.AbstractPlatformTransactionManager;
import org.springframework.transaction.support.DefaultTransactionStatus;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

class ScanAdmissionTimingTest {
    private final Logger logger = (Logger) LoggerFactory.getLogger("com.weblens.scan.admission");
    private final ListAppender<ILoggingEvent> output = new ListAppender<>();
    private Level previousLevel;

    @BeforeEach
    void enableDiagnostic() {
        previousLevel = logger.getLevel();
        logger.setLevel(Level.DEBUG);
        output.start();
        logger.addAppender(output);
    }

    @AfterEach
    void restoreThreadAndLogger() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.clearSynchronization();
        }
        TransactionSynchronizationManager.setActualTransactionActive(false);
        logger.detachAppender(output);
        output.stop();
        logger.setLevel(previousLevel);
    }

    @Test
    void disabledLoggerDoesNotAllocateOrRegisterSynchronization() {
        logger.setLevel(Level.INFO);
        assertThat(ScanService.AdmissionTiming.start(UUID.randomUUID())).isNull();
        assertThat(output.list).isEmpty();
        assertThat(TransactionSynchronizationManager.isSynchronizationActive()).isFalse();
    }

    @Test
    void directCallCannotClaimThatTransactionCommitted() {
        UUID correlationId = UUID.randomUUID();
        ScanService.AdmissionTiming timing = ScanService.AdmissionTiming.start(correlationId);
        timing.stage("user_lock");
        timing.endBody();
        assertThat(output.list).hasSize(1);
        assertThat(output.list.getFirst().getFormattedMessage())
                .contains("correlationId=" + correlationId, "outcome=FAILED", "transactionStatus=NOT_OBSERVED", "user_lock=");
    }

    @Test
    void waitsForTransactionCompletionAndDistinguishesCommitFromRollback() {
        for (int status : new int[]{TransactionSynchronization.STATUS_COMMITTED, TransactionSynchronization.STATUS_ROLLED_BACK}) {
            output.list.clear();
            TransactionSynchronizationManager.initSynchronization();
            TransactionSynchronizationManager.setActualTransactionActive(true);
            UUID scanId = UUID.randomUUID();
            ScanService.AdmissionTiming timing = ScanService.AdmissionTiming.start(UUID.randomUUID());
            timing.stage("save_and_flush");
            timing.stage("outbox_enqueue");
            timing.success("NEW_SCAN", scanId);
            timing.endBody();
            assertThat(output.list).isEmpty();
            assertThat(TransactionSynchronizationManager.getSynchronizations()).hasSize(1);
            TransactionSynchronizationManager.getSynchronizations().getFirst().afterCompletion(status);
            assertThat(output.list).hasSize(1);
            String message = output.list.getFirst().getFormattedMessage();
            assertThat(message).contains("scanId=" + scanId, "save_and_flush=", "outbox_enqueue=", "completionAfterBodyMs=");
            assertThat(message).contains("transactionStatus=" + (status == TransactionSynchronization.STATUS_COMMITTED ? "COMMITTED" : "ROLLED_BACK"));
            assertThat(output.list.getFirst().getThrowableProxy()).isNull();
            TransactionSynchronizationManager.clearSynchronization();
            TransactionSynchronizationManager.setActualTransactionActive(false);
        }
    }

    @Test
    void springProxyReportsCommitFailureEvenWhenCreateBodySucceeded() {
        for (boolean failCommit : new boolean[]{false, true}) {
            output.list.clear();
            UUID userId = UUID.randomUUID();
            UUID websiteId = UUID.randomUUID();
            UUID correlationId = UUID.randomUUID();
            ScanRepository scans = mock(ScanRepository.class);
            WebsiteAccessService websites = mock(WebsiteAccessService.class);
            given(websites.lockOwnedActive(userId, websiteId)).willReturn(
                    new WebsiteAccessService.WebsiteTargetSnapshot(
                            websiteId, userId, "https://example.com/", "example.com"));
            given(scans.saveAndFlush(any())).willAnswer(invocation -> invocation.getArgument(0));
            ScanService target = new ScanService(scans, websites, mock(CurrentUserService.class),
                    new ScanLimitProperties(25, 3, 10_485_760, 120, 5, 3),
                    new IdempotencyKeyService(), mock(ControlMessagingRepository.class), Clock.systemUTC());

            // Real Spring transaction lifecycle, with no database/resource behind this test double.
            AbstractPlatformTransactionManager transactions = new AbstractPlatformTransactionManager() {
                @Override
                protected Object doGetTransaction() { return new Object(); }

                @Override
                protected void doBegin(Object transaction, TransactionDefinition definition) {
                    assertThat(definition.isReadOnly()).isFalse();
                }

                @Override
                protected void doCommit(DefaultTransactionStatus status) {
                    assertThat(output.list).isEmpty();
                    if (failCommit) throw new TransactionSystemException("Simulated commit failure");
                }

                @Override
                protected void doRollback(DefaultTransactionStatus status) {
                    assertThat(output.list).isEmpty();
                }
            };
            transactions.setRollbackOnCommitFailure(true);
            ProxyFactory factory = new ProxyFactory(target);
            factory.setProxyTargetClass(true);
            factory.addAdvice(new TransactionInterceptor(transactions, new AnnotationTransactionAttributeSource()));
            ScanService proxy = (ScanService) factory.getProxy();
            if (failCommit) {
                assertThatThrownBy(() -> proxy.create(userId, websiteId, "diagnostic-key", correlationId))
                        .isInstanceOf(TransactionSystemException.class);
            } else {
                assertThat(proxy.create(userId, websiteId, "diagnostic-key", correlationId).replayed()).isFalse();
            }
            assertThat(output.list).hasSize(1);
            assertThat(output.list.getFirst().getFormattedMessage())
                    .contains("correlationId=" + correlationId, "outcome=NEW_SCAN", "save_and_flush=", "outbox_enqueue=")
                    .contains("transactionStatus=" + (failCommit ? "ROLLED_BACK" : "COMMITTED"))
                    .doesNotContain("diagnostic-key", "example.com", userId.toString(), websiteId.toString());
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(TransactionSynchronizationManager.isSynchronizationActive()).isFalse();
        }
    }
}
