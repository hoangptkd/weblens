package com.weblens.auth.service;

import com.weblens.auth.dto.AuthSessionResponse;
import com.weblens.auth.dto.LoginRequest;
import com.weblens.auth.dto.RegisterRequest;
import com.weblens.auth.entity.AuthSessionEntity;
import com.weblens.auth.entity.UserEntity;
import com.weblens.auth.model.EmailAddress;
import com.weblens.auth.model.UserStatus;
import com.weblens.auth.repository.AuthSessionRepository;
import com.weblens.auth.repository.UserRepository;
import com.weblens.auth.security.JwtTokenService;
import com.weblens.auth.security.RandomTokenService;
import com.weblens.auth.security.TokenHashingService;
import com.weblens.auth.security.TokenPair;
import com.weblens.common.exception.ApiException;
import com.weblens.common.exception.ConflictException;
import com.weblens.common.exception.UnauthorizedException;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

@Service
@Transactional(readOnly = true)
public class AuthenticationService {

    private static final String GENERIC_CREDENTIAL_ERROR = "The email or password is invalid.";

    private final UserRepository users;
    private final AuthSessionRepository sessions;
    private final PasswordEncoder passwords;
    private final JwtTokenService jwtTokens;
    private final TokenHashingService hashes;
    private final RandomTokenService randomTokens;
    private final Clock clock;
    private final TransactionTemplate loginRead;
    private final TransactionTemplate loginWrite;
    private final Timer loginReadTime;
    private final Timer passwordTime;
    private final Timer sessionTime;

    public AuthenticationService(
            UserRepository users,
            AuthSessionRepository sessions,
            PasswordEncoder passwords,
            JwtTokenService jwtTokens,
            TokenHashingService hashes,
            RandomTokenService randomTokens,
            Clock clock,
            PlatformTransactionManager transactionManager,
            MeterRegistry metrics
    ) {
        this.users = users;
        this.sessions = sessions;
        this.passwords = passwords;
        this.jwtTokens = jwtTokens;
        this.hashes = hashes;
        this.randomTokens = randomTokens;
        this.clock = clock;
        this.loginRead = new TransactionTemplate(transactionManager);
        this.loginRead.setReadOnly(true);
        this.loginWrite = new TransactionTemplate(transactionManager);
        this.loginReadTime = metrics.timer("weblens.auth.login.stage", "stage", "lookup");
        this.passwordTime = metrics.timer("weblens.auth.login.stage", "stage", "password");
        this.sessionTime = metrics.timer("weblens.auth.login.stage", "stage", "session");
    }

    @Transactional(propagation = Propagation.NEVER)
    public IssuedAuthentication register(RegisterRequest request) {
        requireBcryptCompatible(request.password(), false);
        EmailAddress email = EmailAddress.of(request.email());
        if (Boolean.TRUE.equals(loginRead.execute(status -> users.existsByNormalizedEmail(email.value())))) {
            throw emailConflict();
        }
        String encodedPassword = passwords.encode(request.password());
        return loginWrite.execute(status -> registerUser(request, email, encodedPassword));
    }

    private IssuedAuthentication registerUser(RegisterRequest request, EmailAddress email, String encodedPassword) {
        Instant now = clock.instant();
        UserEntity user = new UserEntity(
                UUID.randomUUID(),
                email.value(),
                email.value(),
                request.displayName().strip(),
                encodedPassword,
                UserStatus.ACTIVE,
                now,
                now
        );
        try {
            users.saveAndFlush(user);
        } catch (DataIntegrityViolationException exception) {
            throw emailConflict();
        }
        return createSession(user, now);
    }

    @Transactional(propagation = Propagation.NEVER)
    public IssuedAuthentication login(LoginRequest request) {
        requireBcryptCompatible(request.password(), true);
        EmailAddress email = EmailAddress.of(request.email());
        LoginCredential credential = loginReadTime.record(() -> loginRead.execute(status -> {
            UserEntity user = users.findByNormalizedEmail(email.value()).orElseThrow(this::invalidCredentials);
            if (user.getStatus() != UserStatus.ACTIVE) {
                throw invalidCredentials();
            }
            return new LoginCredential(user.getId(), user.getPasswordHash(), user.getVersion());
        }));
        if (!passwordTime.record(() -> passwords.matches(request.password(), credential.passwordHash()))) {
            throw invalidCredentials();
        }
        // Re-read under the existing user lock: credentials may change while bcrypt runs.
        return sessionTime.record(() -> loginWrite.execute(status -> {
            UserEntity user = users.findByIdForUpdate(credential.id()).orElseThrow(this::invalidCredentials);
            if (user.getStatus() != UserStatus.ACTIVE
                    || user.getVersion() != credential.version()
                    || !user.getPasswordHash().equals(credential.passwordHash())
                    || !user.getNormalizedEmail().equals(email.value())) {
                throw invalidCredentials();
            }
            return createSession(user, clock.instant());
        }));
    }

    private record LoginCredential(UUID id, String passwordHash, long version) {
        @Override
        public String toString() {
            return "LoginCredential[redacted]";
        }
    }

    @Transactional
    public IssuedAuthentication refresh(String refreshToken, String csrfToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            throw invalidRefresh();
        }
        Jwt refreshJwt = jwtTokens.decodeRefresh(refreshToken);
        UUID sessionId = uuidClaim(refreshJwt.getClaimAsString(JwtTokenService.SESSION_ID));
        UUID userId = uuidClaim(refreshJwt.getSubject());
        String tokenId = refreshJwt.getId();

        AuthSessionEntity session = sessions.findByIdForUpdate(sessionId)
                .orElseThrow(this::invalidRefresh);
        Instant now = clock.instant();
        if (!session.isUsableAt(now)
                || !session.getUserId().equals(userId)
                || tokenId == null
                || csrfToken == null
                || !hashes.matches(tokenId, session.getRefreshJtiHash())
                || !hashes.matches(csrfToken, session.getCsrfTokenHash())) {
            throw invalidRefresh();
        }

        UserEntity user = users.findById(userId).orElseThrow(this::invalidRefresh);
        if (user.getStatus() != UserStatus.ACTIVE) {
            throw invalidRefresh();
        }

        TokenPair pair = jwtTokens.issue(userId, sessionId);
        String nextCsrf = randomTokens.create();
        session.rotate(
                hashes.hash(pair.refreshJti()),
                hashes.hash(nextCsrf),
                pair.refreshExpiresAt(),
                now
        );
        return issued(user, pair, nextCsrf);
    }

    @Transactional
    public void logout(String refreshToken, String csrfToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            return;
        }
        try {
            Jwt refreshJwt = jwtTokens.decodeRefresh(refreshToken);
            UUID sessionId = uuidClaim(refreshJwt.getClaimAsString(JwtTokenService.SESSION_ID));
            String tokenId = refreshJwt.getId();
            sessions.findByIdForUpdate(sessionId).ifPresent(session -> {
                if (tokenId != null
                        && csrfToken != null
                        && hashes.matches(tokenId, session.getRefreshJtiHash())
                        && hashes.matches(csrfToken, session.getCsrfTokenHash())) {
                    session.revoke(clock.instant());
                }
            });
        } catch (UnauthorizedException ignored) {
            // Logout deliberately does not reveal whether a session/token exists.
        }
    }

    private IssuedAuthentication createSession(UserEntity user, Instant now) {
        UUID sessionId = UUID.randomUUID();
        TokenPair pair = jwtTokens.issue(user.getId(), sessionId);
        String csrfToken = randomTokens.create();
        sessions.save(new AuthSessionEntity(
                sessionId,
                user.getId(),
                hashes.hash(pair.refreshJti()),
                hashes.hash(csrfToken),
                pair.refreshExpiresAt(),
                now
        ));
        return issued(user, pair, csrfToken);
    }

    private IssuedAuthentication issued(UserEntity user, TokenPair pair, String csrfToken) {
        AuthSessionResponse response = new AuthSessionResponse(
                CurrentUserService.toResponse(user),
                pair.accessToken(),
                "Bearer",
                pair.accessExpiresAt()
        );
        return new IssuedAuthentication(response, pair.refreshToken(), csrfToken);
    }

    private UUID uuidClaim(String value) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException | NullPointerException exception) {
            throw invalidRefresh();
        }
    }

    private ConflictException emailConflict() {
        return new ConflictException("EMAIL_ALREADY_REGISTERED", "An account already uses this email address.");
    }

    private UnauthorizedException invalidCredentials() {
        return new UnauthorizedException("INVALID_CREDENTIALS", GENERIC_CREDENTIAL_ERROR);
    }

    private UnauthorizedException invalidRefresh() {
        return new UnauthorizedException("INVALID_REFRESH_TOKEN", "The refresh credential is invalid or expired.");
    }

    private void requireBcryptCompatible(String password, boolean hidePolicy) {
        if (password.getBytes(StandardCharsets.UTF_8).length <= 72) {
            return;
        }
        if (hidePolicy) {
            throw invalidCredentials();
        }
        throw new ApiException(
                org.springframework.http.HttpStatus.BAD_REQUEST,
                "PASSWORD_TOO_LONG",
                "Password is too long",
                "The UTF-8 encoded password must not exceed 72 bytes."
        );
    }
}
