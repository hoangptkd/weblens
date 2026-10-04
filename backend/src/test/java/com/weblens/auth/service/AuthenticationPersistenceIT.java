package com.weblens.auth.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.weblens.auth.dto.RegisterRequest;
import com.weblens.auth.dto.LoginRequest;
import com.weblens.common.exception.UnauthorizedException;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

// No test-level transaction: each service invocation must commit independently.
@SpringBootTest
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker = true)
class AuthenticationPersistenceIT {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17.6-alpine");

    @Autowired
    private AuthenticationService auth;

    @Autowired
    private JdbcTemplate jdbc;

    @MockitoSpyBean
    private PasswordEncoder passwords;

    @Test
    void loginReleasesReadTransactionBeforeBcryptAndCommitsSession() {
        var original = register();
        org.mockito.Mockito.doAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            return invocation.callRealMethod();
        }).when(passwords).matches(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString());
        var loggedIn = auth.login(new LoginRequest(original.response().user().email(), "test-only-strong-password-2026"));
        assertThat(loggedIn.response().user().id()).isEqualTo(original.response().user().id());
        assertThat(jdbc.queryForObject("SELECT count(*) FROM auth_sessions WHERE user_id = ?", Long.class,
                loggedIn.response().user().id())).isEqualTo(2L);
    }

    @Test
    void userDisabledBetweenLookupAndSessionWriteCannotLogIn() {
        var original = register();
        org.mockito.Mockito.doAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            jdbc.update("UPDATE users SET status = 'DISABLED', version = version + 1 WHERE id = ?",
                    original.response().user().id());
            return invocation.callRealMethod();
        }).when(passwords).matches(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString());
        assertThatThrownBy(() -> auth.login(new LoginRequest(original.response().user().email(), "test-only-strong-password-2026")))
                .isInstanceOf(UnauthorizedException.class);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM auth_sessions WHERE user_id = ?", Long.class,
                original.response().user().id())).isEqualTo(1L);
    }

    @Test
    void concurrentRefreshAllowsOnlyOneUseOfOldCredential() throws Exception {
        IssuedAuthentication original = register();
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var first = executor.submit(() -> refreshAfterBarrier(original, ready, start));
            var second = executor.submit(() -> refreshAfterBarrier(original, ready, start));
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            IssuedAuthentication one = first.get(15, TimeUnit.SECONDS);
            IssuedAuthentication two = second.get(15, TimeUnit.SECONDS);
            assertThat((one == null) != (two == null)).isTrue();
            IssuedAuthentication winner = one != null ? one : two;
            assertThat(winner.refreshToken()).isNotEqualTo(original.refreshToken());
            assertThat(jdbc.queryForObject("SELECT count(*) FROM auth_sessions WHERE user_id = ?",
                    Long.class, original.response().user().id())).isEqualTo(1L);

            // A losing replay does not silently replace or invalidate the winner.
            IssuedAuthentication next = auth.refresh(winner.refreshToken(), winner.csrfToken());
            auth.logout(next.refreshToken(), next.csrfToken());
            auth.logout(next.refreshToken(), next.csrfToken());
            assertThatThrownBy(() -> auth.refresh(next.refreshToken(), next.csrfToken()))
                    .isInstanceOf(UnauthorizedException.class);
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void disabledUserCannotRefreshPersistedSession() {
        IssuedAuthentication original = register();
        jdbc.update("UPDATE users SET status = 'DISABLED', version = version + 1 WHERE id = ?",
                original.response().user().id());
        assertThatThrownBy(() -> auth.refresh(original.refreshToken(), original.csrfToken()))
                .isInstanceOf(UnauthorizedException.class);
    }

    private IssuedAuthentication refreshAfterBarrier(
            IssuedAuthentication original, CountDownLatch ready, CountDownLatch start) throws InterruptedException {
        ready.countDown();
        if (!start.await(5, TimeUnit.SECONDS)) {
            throw new AssertionError("Refresh start barrier timed out");
        }
        try {
            return auth.refresh(original.refreshToken(), original.csrfToken());
        } catch (UnauthorizedException expectedReplayRejection) {
            return null;
        }
    }

    private IssuedAuthentication register() {
        return auth.register(new RegisterRequest(UUID.randomUUID() + "@example.com",
                "test-only-strong-password-2026", "Test user"));
    }
}
