package com.weblens.auth.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.verifyNoInteractions;

import com.weblens.auth.dto.LoginRequest;
import com.weblens.auth.dto.RegisterRequest;
import com.weblens.auth.entity.UserEntity;
import com.weblens.auth.model.UserStatus;
import com.weblens.auth.repository.AuthSessionRepository;
import com.weblens.auth.repository.UserRepository;
import com.weblens.auth.security.JwtTokenService;
import com.weblens.auth.security.RandomTokenService;
import com.weblens.auth.security.TokenHashingService;
import com.weblens.auth.security.TokenPair;
import com.weblens.common.exception.UnauthorizedException;
import com.weblens.support.BoundaryTransactionManager;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.TransactionSystemException;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;

@ExtendWith(MockitoExtension.class)
class AuthenticationServiceTest {
    @Mock UserRepository users;
    @Mock AuthSessionRepository sessions;
    @Mock PasswordEncoder passwords;
    @Mock JwtTokenService jwtTokens;
    @Mock TokenHashingService hashes;
    @Mock RandomTokenService randomTokens;

    private final UUID userId = UUID.randomUUID();
    private final Instant now = Instant.parse("2026-10-01T08:00:00Z");
    private final LoginRequest request = new LoginRequest("test@example.com", "test-password");
    private BoundaryTransactionManager transactions;
    private SimpleMeterRegistry metrics;
    private AuthenticationService service;

    @BeforeEach
    void setUp() {
        transactions = new BoundaryTransactionManager();
        metrics = new SimpleMeterRegistry();
        var target = new AuthenticationService(users, sessions, passwords, jwtTokens, hashes, randomTokens,
                Clock.fixed(now, java.time.ZoneOffset.UTC), transactions, metrics);
        var proxy = new ProxyFactory(target);
        proxy.addAdvice(new TransactionInterceptor(transactions, new AnnotationTransactionAttributeSource()));
        service = (AuthenticationService) proxy.getProxy();
    }

    @Test
    void registrationHashesOutsideTransactionAndPersistsUserAndSessionTogether() {
        var registration = new RegisterRequest(request.email(), request.password(), "Test");
        given(users.existsByNormalizedEmail(request.email())).willAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isCurrentTransactionReadOnly()).isTrue();
            return false;
        });
        given(passwords.encode(request.password())).willAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(transactions.commits).isEqualTo(1);
            return "hash";
        });
        given(users.saveAndFlush(any())).willAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
            assertThat(TransactionSynchronizationManager.isCurrentTransactionReadOnly()).isFalse();
            return invocation.getArgument(0);
        });
        given(jwtTokens.issue(any(UUID.class), any(UUID.class))).willReturn(new TokenPair(
                "access", now.plusSeconds(60), "refresh", "jti", now.plusSeconds(600)));
        given(randomTokens.create()).willReturn("csrf");
        given(sessions.save(any())).willAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
            return invocation.getArgument(0);
        });

        assertThat(service.register(registration).response().user().email()).isEqualTo(request.email());
        assertThat(transactions.commits).isEqualTo(2);
        assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
    }

    @Test
    void bcryptRunsAfterReadCommitAndSessionIsCreatedInNewTransaction() {
        stubLookup(true);
        given(users.findByIdForUpdate(userId)).willAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
            assertThat(TransactionSynchronizationManager.isCurrentTransactionReadOnly()).isFalse();
            return Optional.of(user("hash", UserStatus.ACTIVE));
        });
        given(jwtTokens.issue(eq(userId), any(UUID.class))).willReturn(new TokenPair(
                "access", now.plusSeconds(60), "refresh", "jti", now.plusSeconds(600)));
        given(randomTokens.create()).willReturn("csrf");
        given(sessions.save(any())).willAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
            return invocation.getArgument(0);
        });

        assertThat(service.login(request).response().user().id()).isEqualTo(userId);
        assertThat(transactions.commits).isEqualTo(2);
        assertThat(metrics.get("weblens.auth.login.stage").tag("stage", "password").timer().count()).isEqualTo(1);
        assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
    }

    @Test
    void invalidPasswordDoesNotCreateSessionOrAcquireWriteLock() {
        stubLookup(false);
        assertThatThrownBy(() -> service.login(request)).isInstanceOf(UnauthorizedException.class);
        verifyNoInteractions(sessions, jwtTokens);
        assertThat(transactions.commits).isEqualTo(1);
    }

    @Test
    void disabledUserDuringPasswordCheckCannotReceiveSession() {
        stubLookup(true);
        given(users.findByIdForUpdate(userId)).willReturn(Optional.of(user("hash", UserStatus.DISABLED)));
        assertThatThrownBy(() -> service.login(request)).isInstanceOf(UnauthorizedException.class);
        verifyNoInteractions(sessions, jwtTokens);
        assertThat(transactions.rollbacks).isEqualTo(1);
    }

    @Test
    void changedPasswordDuringCheckCannotReceiveSession() {
        stubLookup(true);
        given(users.findByIdForUpdate(userId)).willReturn(Optional.of(user("new-hash", UserStatus.ACTIVE)));
        assertThatThrownBy(() -> service.login(request)).isInstanceOf(UnauthorizedException.class);
        verifyNoInteractions(sessions, jwtTokens);
    }

    @Test
    void deletedUserDuringCheckCannotReceiveSession() {
        stubLookup(true);
        given(users.findByIdForUpdate(userId)).willReturn(Optional.empty());
        assertThatThrownBy(() -> service.login(request)).isInstanceOf(UnauthorizedException.class);
        verifyNoInteractions(sessions, jwtTokens);
    }

    @Test
    void loginRejectsAnAmbientTransactionBeforeBcrypt() {
        assertThatThrownBy(() -> new TransactionTemplate(transactions).execute(status -> service.login(request)))
                .isInstanceOf(IllegalTransactionStateException.class);
        verifyNoInteractions(users, passwords, sessions);
        assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
    }

    @Test
    void failedReadCommitDoesNotRunPasswordCheck() {
        given(users.findByNormalizedEmail(request.email())).willReturn(Optional.of(user("hash", UserStatus.ACTIVE)));
        transactions.failCommit = true;
        assertThatThrownBy(() -> service.login(request)).isInstanceOf(TransactionSystemException.class);
        verifyNoInteractions(passwords, sessions);
        assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
    }

    @Test
    void failedSessionCommitCannotReturnIssuedCredentials() {
        stubLookup(true);
        given(users.findByIdForUpdate(userId)).willReturn(Optional.of(user("hash", UserStatus.ACTIVE)));
        given(jwtTokens.issue(eq(userId), any(UUID.class))).willReturn(new TokenPair(
                "access", now.plusSeconds(60), "refresh", "jti", now.plusSeconds(600)));
        given(randomTokens.create()).willReturn("csrf");
        given(sessions.save(any())).willAnswer(invocation -> {
            transactions.failCommit = true;
            return invocation.getArgument(0);
        });
        assertThatThrownBy(() -> service.login(request)).isInstanceOf(TransactionSystemException.class);
        assertThat(transactions.commits).isEqualTo(1);
        assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
    }

    @Test
    void changedUserVersionCannotReceiveSession() {
        stubLookup(true);
        var changed = user("hash", UserStatus.ACTIVE);
        org.springframework.test.util.ReflectionTestUtils.setField(changed, "version", 1L);
        given(users.findByIdForUpdate(userId)).willReturn(Optional.of(changed));
        assertThatThrownBy(() -> service.login(request)).isInstanceOf(UnauthorizedException.class);
        verifyNoInteractions(sessions, jwtTokens);
    }

    private void stubLookup(boolean matches) {
        given(users.findByNormalizedEmail(request.email())).willAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isTrue();
            assertThat(TransactionSynchronizationManager.isCurrentTransactionReadOnly()).isTrue();
            return Optional.of(user("hash", UserStatus.ACTIVE));
        });
        given(passwords.matches(request.password(), "hash")).willAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(transactions.commits).isEqualTo(1);
            return matches;
        });
    }

    private UserEntity user(String hash, UserStatus status) {
        return new UserEntity(userId, request.email(), request.email(), "Test", hash, status, now, now);
    }
}
