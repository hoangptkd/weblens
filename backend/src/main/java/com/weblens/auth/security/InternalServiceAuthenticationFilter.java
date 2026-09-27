package com.weblens.auth.security;

import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.http.HttpStatus;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class InternalServiceAuthenticationFilter extends OncePerRequestFilter {

    static final int MAX_INTERNAL_BODY_BYTES = 64 * 1024;
    private static final String INTERNAL_PREFIX = "/internal/v1/";
    private static final String METRICS_PATH = "/actuator/metrics";
    private static final String TOKEN_HEADER = "X-WebLens-Service-Token";

    private final byte[] expectedTokenDigest;
    private final ProblemDetailsFactory problems;
    private final ProblemResponseWriter writer;

    public InternalServiceAuthenticationFilter(
            @Value("${weblens.crawler.service-token}")
            String serviceToken,
            ProblemDetailsFactory problems,
            ProblemResponseWriter writer
    ) {
        expectedTokenDigest = digest(serviceToken);
        this.problems = problems;
        this.writer = writer;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return !path.startsWith(INTERNAL_PREFIX)
                && !path.equals(METRICS_PATH)
                && !path.startsWith(METRICS_PATH + "/");
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain
    ) throws ServletException, IOException {
        String suppliedToken = request.getHeader(TOKEN_HEADER);
        if (suppliedToken == null
                || suppliedToken.isBlank()
                || !MessageDigest.isEqual(expectedTokenDigest, digest(suppliedToken))) {
            writer.write(response, problems.create(
                    HttpStatus.UNAUTHORIZED,
                    "SERVICE_AUTHENTICATION_REQUIRED",
                    "Service authentication required",
                    "Valid service authentication is required.",
                    request
            ));
            return;
        }

        byte[] body = request.getInputStream().readNBytes(MAX_INTERNAL_BODY_BYTES + 1);
        if (body.length > MAX_INTERNAL_BODY_BYTES) {
            writer.write(response, problems.create(
                    HttpStatus.PAYLOAD_TOO_LARGE,
                    "INTERNAL_PAYLOAD_TOO_LARGE",
                    "Internal payload is too large",
                    "Internal JSON messages are limited to 64 KiB.",
                    request
            ));
            return;
        }
        filterChain.doFilter(new BodyRequestWrapper(request, body), response);
    }

    private static byte[] digest(String value) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (java.security.NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is not available", exception);
        }
    }

    private static final class BodyRequestWrapper extends HttpServletRequestWrapper {

        private final byte[] body;

        private BodyRequestWrapper(HttpServletRequest request, byte[] body) {
            super(request);
            this.body = body.clone();
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream input = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override
                public int read() {
                    return input.read();
                }

                @Override
                public boolean isFinished() {
                    return input.available() == 0;
                }

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setReadListener(ReadListener readListener) {
                    throw new UnsupportedOperationException("Async request reading is not supported");
                }
            };
        }

        @Override
        public BufferedReader getReader() {
            return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
        }

        @Override
        public int getContentLength() {
            return body.length;
        }

        @Override
        public long getContentLengthLong() {
            return body.length;
        }
    }
}
