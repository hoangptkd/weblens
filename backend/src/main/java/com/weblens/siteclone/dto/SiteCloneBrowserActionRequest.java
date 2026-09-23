package com.weblens.siteclone.dto;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.Map;

public record SiteCloneBrowserActionRequest(
        @NotNull Type type,
        @Min(0) @Max(1364) Integer x,
        @Min(0) @Max(767) Integer y,
        @Size(min = 1, max = 4096) String text,
        @Size(min = 1, max = 16) String key,
        @Min(-2000) @Max(2000) Integer deltaY
) {
    public enum Type { click, type, key, scroll }

    @AssertTrue(message = "The browser action fields do not match its type.")
    public boolean isValidCombination() {
        if (type == null) {
            return false;
        }
        return switch (type) {
            case click -> x != null && y != null;
            case type -> text != null && !text.isEmpty();
            case key -> key != null && !key.isEmpty();
            case scroll -> deltaY != null && deltaY != 0;
        };
    }

    public Map<String, Object> toAction() {
        return switch (type) {
            case click -> Map.of("type", type.name(), "x", x, "y", y);
            case type -> Map.of("type", type.name(), "text", text);
            case key -> Map.of("type", type.name(), "key", key);
            case scroll -> Map.of("type", type.name(), "deltaY", deltaY);
        };
    }
}
