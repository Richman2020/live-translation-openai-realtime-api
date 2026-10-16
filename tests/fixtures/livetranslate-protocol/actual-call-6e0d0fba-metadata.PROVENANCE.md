# Real call metadata projection

Fixture: `actual-call-6e0d0fba-metadata.redacted.json`
SHA-256: `8b796b13295dacbd2dd0c9e4c5e959f57f32b1f7290e6794afa04ef41e600370`

This is a deterministic replay/check of captured application diagnostic metadata, **not** a provider WebSocket frame replay, audio replay or evidence of a completed real-call fix. The call UUID and exact baseline/deployment identifiers are retained to correlate the incident. No supplier event/item/session ID, recording, speech/transcript text, phone number, credential, header or request body is included.

## Sources and projection

The source files and their actual SHA-256 hashes are recorded in the fixture's provenance. They were exported from the existing read-only Railway call diagnostic evidence for call `6e0d0fba-85b4-4354-a26d-db12750716fc`. The repository fixture is self-contained; tests do not depend on any audit directory or platform/network access.

- ACTUAL_RESPONSE_LIFECYCLE.json: all 30 selected response lifecycle rows; allowlist role, stage, application at, local source/response/sequence ordinals and null actualPlaybackStartAt.
- ACTUAL_SOURCE_INPUT_OFFSETS.json: all 10 source observations; allowlist role, application at, local source ordinal, providerAudioMs, application inputAudioMs counter and arithmetic differenceMs.
- ACTUAL_CALL_EVENTS.json: select the first fatal protocol_failure, subsequent failed state and call termination; retain fixed diagnostic enum values, receive ordinal and numeric time. Select the rows attaining peak queuedBytes/outstandingAudioMs with the same numeric/enum allowlist. No full runtime log is checked in.

`inputAudioMs` is the old application counter advanced after append was accepted; it is not evidence of bytes written, supplier receipt or acoustic speech time. Provider offsets are estimated supplier stream positions. Their difference is not end-to-end latency. The termination uses observedAtMs as application at, not later log-ingestion timestamp. Thus first fatal to call-end request is 61,903 ms; failed-state to request is 61,900 ms.

## What remains unknown

The old send diagnostic only recorded numeric type: it cannot distinguish non-OPEN socket state from buffered bytes exceeding the old threshold. The fixture intentionally does not invent readyState, bufferedAmount, write callbacks or raw provider frames. Response 10 was created/completed without first-audio or playback-queue evidence; missing output content means its legality as an empty response or dropped speech remains unknown. Null playback-start measurements do not prove actual ear-end playback time. Static screenshots and this metadata do not establish real acoustic chronology or the cause of cross-track repeated Chinese.

The 10 captured responses (6 local, 4 remote) are far below 257. The unrelated response-257 capacity limit remains unresolved. The five local responses with captured first audio all have captured playback_drained. Peak queue observations alone do not prove a sustained backlog or disprove every short-lived delay.
