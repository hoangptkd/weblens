package com.weblens.messaging;

import com.weblens.messaging.contract.CaptureEventEnvelope;
import com.weblens.messaging.contract.EventAcknowledgement;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/v1/events")
public class CaptureEventController {

    private final CaptureEventService events;

    public CaptureEventController(CaptureEventService events) {
        this.events = events;
    }

    @PostMapping("/captures")
    EventAcknowledgement consume(@Valid @RequestBody CaptureEventEnvelope envelope) {
        CaptureEventService.ConsumeResult result = events.consume(envelope);
        return new EventAcknowledgement(true, result.duplicate(), result.outcome());
    }
}
