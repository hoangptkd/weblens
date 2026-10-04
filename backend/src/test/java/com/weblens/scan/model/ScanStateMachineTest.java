package com.weblens.scan.model;

import static org.assertj.core.api.Assertions.assertThatNoException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class ScanStateMachineTest {

    @Test
    void permitsDocumentedForwardTransitions() {
        assertThatNoException().isThrownBy(() -> ScanStateMachine.requireTransition(
                ScanStatus.QUEUED,
                ScanStatus.CANCEL_REQUESTED
        ));
        assertThatNoException().isThrownBy(() -> ScanStateMachine.requireTransition(
                ScanStatus.QUEUED,
                ScanStatus.RUNNING
        ));
        assertThatNoException().isThrownBy(() -> ScanStateMachine.requireTransition(
                ScanStatus.RUNNING,
                ScanStatus.CANCEL_REQUESTED
        ));
        assertThatNoException().isThrownBy(() -> ScanStateMachine.requireTransition(
                ScanStatus.CANCEL_REQUESTED,
                ScanStatus.CANCELLED
        ));
    }

    @Test
    void preventsTerminalStatesFromResuming() {
        assertThatThrownBy(() -> ScanStateMachine.requireTransition(
                ScanStatus.COMPLETED,
                ScanStatus.RUNNING
        )).isInstanceOf(InvalidScanTransitionException.class);
    }
}
