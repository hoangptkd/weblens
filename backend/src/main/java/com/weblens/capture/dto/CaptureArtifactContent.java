package com.weblens.capture.dto;

import java.util.Arrays;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.core.io.Resource;
import org.springframework.core.io.FileSystemResource;

public record CaptureArtifactContent(byte[] bytes, String contentType, String etag, String filename,
        Path temporaryFile, long contentLength) implements AutoCloseable {

    public CaptureArtifactContent(byte[] bytes, String contentType, String etag, String filename) {
        this(bytes, contentType, etag, filename, null, bytes.length);
    }

    public CaptureArtifactContent(byte[] bytes, String contentType, String etag) {
        this(bytes, contentType, etag, null);
    }

    public CaptureArtifactContent {
        if (bytes != null) bytes = Arrays.copyOf(bytes, bytes.length);
    }

    @Override
    public byte[] bytes() {
        if (temporaryFile != null) {
            try { return Files.readAllBytes(temporaryFile); }
            catch (IOException exception) { throw new java.io.UncheckedIOException(exception); }
        }
        return Arrays.copyOf(bytes, bytes.length);
    }

    public Resource resource() {
        return temporaryFile == null ? new org.springframework.core.io.ByteArrayResource(bytes)
                : new FileSystemResource(temporaryFile);
    }

    @Override
    public void close() throws IOException {
        if (temporaryFile != null) Files.deleteIfExists(temporaryFile);
    }
}
