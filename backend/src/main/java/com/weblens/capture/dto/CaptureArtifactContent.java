package com.weblens.capture.dto;

import java.util.Arrays;

public record CaptureArtifactContent(byte[] bytes, String contentType, String etag, String filename) {

    public CaptureArtifactContent(byte[] bytes, String contentType, String etag) {
        this(bytes, contentType, etag, null);
    }

    public CaptureArtifactContent {
        bytes = Arrays.copyOf(bytes, bytes.length);
    }

    @Override
    public byte[] bytes() {
        return Arrays.copyOf(bytes, bytes.length);
    }
}
