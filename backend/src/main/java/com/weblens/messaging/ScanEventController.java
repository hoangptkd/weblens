package com.weblens.messaging;

import com.weblens.messaging.contract.ScanEventEnvelope;
import com.weblens.messaging.contract.EventAcknowledgement;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/v1/events")
public class ScanEventController {

    private final ScanEventService events;

    public ScanEventController(ScanEventService events) {
        this.events = events;
    }

    @PostMapping("/scans")
    EventAcknowledgement consume(@Valid @RequestBody ScanEventEnvelope envelope) {
        ScanEventService.ConsumeResult result = events.consume(envelope);
        return new EventAcknowledgement(true, result.duplicate(), result.outcome());
    }
}
