package com.weblens.capture.controller;

import com.weblens.capture.dto.CaptureArtifactContent;
import com.weblens.common.exception.ProblemDetailsFactory;
import com.weblens.common.exception.ProblemResponseWriter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.concurrent.Semaphore;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(Ordered.LOWEST_PRECEDENCE)
public class ArtifactDownloadFilter extends OncePerRequestFilter {
    public static final String ARTIFACT = ArtifactDownloadFilter.class.getName();
    // Two bounded disk-backed transfers; small screenshot/resource endpoints share admission.
    private final Semaphore downloads = new Semaphore(2);
    private final ProblemDetailsFactory problems;
    private final ProblemResponseWriter writer;

    public ArtifactDownloadFilter(ProblemDetailsFactory problems, ProblemResponseWriter writer) {
        this.problems = problems;
        this.writer = writer;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith("/api/v1/") ||
                (!request.getRequestURI().contains("/artifacts/") && !request.getRequestURI().endsWith("/content"));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        if ("HEAD".equals(request.getMethod())) {
            response.setHeader("Allow", "GET");
            response.sendError(405);
            return;
        }
        if (!downloads.tryAcquire()) {
            response.setHeader("Retry-After", "2");
            writer.write(response, problems.create(HttpStatus.SERVICE_UNAVAILABLE, "ARTIFACT_DOWNLOAD_CAPACITY",
                    "Download capacity reached", "Retry the artifact download shortly.", request));
            return;
        }
        try {
            chain.doFilter(request, response);
        } finally {
            try {
                if (request.getAttribute(ARTIFACT) instanceof CaptureArtifactContent artifact) artifact.close();
            } finally { downloads.release(); }
        }
    }
}
