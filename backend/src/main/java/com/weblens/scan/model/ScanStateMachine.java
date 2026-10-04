package com.weblens.scan.model;

import java.util.EnumSet;
import java.util.Map;
import java.util.Set;

public final class ScanStateMachine {

    private static final Map<ScanStatus, Set<ScanStatus>> ALLOWED = Map.of(
            ScanStatus.QUEUED, EnumSet.of(
                    ScanStatus.RUNNING,
                    ScanStatus.CANCEL_REQUESTED,
                    ScanStatus.COMPLETED,
                    ScanStatus.PARTIAL_SUCCESS,
                    ScanStatus.CANCELLED,
                    ScanStatus.FAILED
            ),
            ScanStatus.RUNNING, EnumSet.of(
                    ScanStatus.CANCEL_REQUESTED,
                    ScanStatus.COMPLETED,
                    ScanStatus.PARTIAL_SUCCESS,
                    ScanStatus.FAILED,
                    ScanStatus.CANCELLED
            ),
            ScanStatus.CANCEL_REQUESTED, EnumSet.of(
                    ScanStatus.COMPLETED,
                    ScanStatus.PARTIAL_SUCCESS,
                    ScanStatus.CANCELLED,
                    ScanStatus.FAILED
            )
    );

    private ScanStateMachine() {
    }

    public static void requireTransition(ScanStatus current, ScanStatus next) {
        if (!ALLOWED.getOrDefault(current, Set.of()).contains(next)) {
            throw new InvalidScanTransitionException(current, next);
        }
    }
}
