package com.weblens.auth.security;

import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Semaphore;
import org.springframework.core.annotation.Order;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** Single-node admission; the approved Windows topology runs one Control Plane. */
@Component
@Order(0)
public class AuthenticationRateLimitFilter extends OncePerRequestFilter {
    private final Semaphore active = new Semaphore(4);
    private final Map<String, Window> windows = new HashMap<>();
    private final Clock clock;
    private final ProblemDetailsFactory problems;
    private final ProblemResponseWriter writer;

    @Autowired
    public AuthenticationRateLimitFilter(ProblemDetailsFactory problems, ProblemResponseWriter writer) {
        this(Clock.systemUTC(), problems, writer);
    }

    AuthenticationRateLimitFilter(Clock clock, ProblemDetailsFactory problems, ProblemResponseWriter writer) {
        this.clock = clock;
        this.problems = problems;
        this.writer = writer;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !"POST".equals(request.getMethod()) || !java.util.Set.of(
                "/api/v1/auth/sessions", "/api/v1/auth/registrations", "/api/v1/auth/token-refreshes")
                .contains(request.getRequestURI());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        if (!admit(clientAddress(request)) || !active.tryAcquire()) {
            response.setHeader("Retry-After", "60");
            writer.write(response, problems.create(HttpStatus.TOO_MANY_REQUESTS, "AUTH_RATE_LIMITED",
                    "Too many authentication requests", "Retry authentication shortly.", request));
            return;
        }
        try { chain.doFilter(request, response); }
        finally { active.release(); }
    }

    private synchronized boolean admit(String address) {
        long now = clock.millis();
        Window window = windows.get(address);
        if (window == null || now - window.started >= 60_000) {
            if (windows.size() >= 10_000) windows.entrySet().removeIf(entry -> now - entry.getValue().started >= 60_000);
            if (window == null && windows.size() >= 10_000) return false;
            window = new Window(now);
            windows.put(address, window);
        }
        return ++window.count <= 60;
    }

    private static String clientAddress(HttpServletRequest request) {
        String remote = request.getRemoteAddr();
        // Trust the last hop appended by the local Caddy proxy, never a public client's header.
        if ("127.0.0.1".equals(remote) || "::1".equals(remote) || "0:0:0:0:0:0:0:1".equals(remote)) {
            String forwarded = request.getHeader("X-Forwarded-For");
            if (forwarded != null && forwarded.length() <= 1024) {
                String last = forwarded.substring(forwarded.lastIndexOf(',') + 1).strip();
                if (last.matches("[0-9a-fA-F:.]{3,64}")) return last;
            }
        }
        return remote == null ? "unknown" : remote;
    }

    private static final class Window {
        private final long started;
        private int count;
        private Window(long started) { this.started = started; }
    }
}
