package com.weblens.siteclone.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CreateSiteCloneRequest(
        @NotBlank @Size(max = 2048) String url
) {
}
