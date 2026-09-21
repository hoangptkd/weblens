package com.weblens.scan.dto;

import java.util.List;

public record ScanPageFilter(
        boolean issuesOnly,
        List<String> outcomes,
        Integer statusMin,
        Integer statusMax,
        String q,
        Boolean indexable,
        List<String> contentTypes,
        List<String> severities,
        List<String> findingCodes
) {
    public ScanPageFilter {
        outcomes = copy(outcomes);
        contentTypes = copy(contentTypes);
        severities = copy(severities);
        findingCodes = copy(findingCodes);
    }

    private static List<String> copy(List<String> values) {
        return values == null ? List.of() : List.copyOf(values);
    }
}
