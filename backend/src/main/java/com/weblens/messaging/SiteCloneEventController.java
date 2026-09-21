package com.weblens.messaging;

import com.weblens.messaging.contract.SiteCloneEventEnvelope;
import com.weblens.messaging.contract.EventAcknowledgement;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/v1/events/site-clones")
public class SiteCloneEventController {

    private final SiteCloneEventService events;

    public SiteCloneEventController(SiteCloneEventService events) {
        this.events = events;
    }

    @PostMapping
    EventAcknowledgement consume(@Valid @RequestBody SiteCloneEventEnvelope envelope) {
        SiteCloneEventService.ConsumeResult result = events.consume(envelope);
        return new EventAcknowledgement(true, result.duplicate(), result.outcome());
    }
}
