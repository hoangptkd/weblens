package com.weblens.siteclone.model;

public enum SiteCloneStatus {
    WAITING_FOR_SCAN,
    QUEUED,
    DISPATCHED,
    RUNNING,
    ASSEMBLING,
    CANCEL_REQUESTED,
    PUBLISHED,
    PARTIAL,
    FAILED,
    CANCELLED,
    EXPIRED;

    public boolean isTerminal() {
        return this == PUBLISHED || this == PARTIAL || this == FAILED
                || this == CANCELLED || this == EXPIRED;
    }
}
