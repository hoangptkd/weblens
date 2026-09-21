package com.weblens.messaging.contract;

public record EventAcknowledgement(
        boolean accepted,
        boolean duplicate,
        String outcome
) {
}
