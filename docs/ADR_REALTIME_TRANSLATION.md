# ADR: retain the phone engines while evaluating native translation

Date: 2026-10-10. Status: existing candidate selected for a bounded cloud trial;
no paid request or deployment in this milestone.

The user has now approved the existing `continuous-captions` route for the
Virginia cloud trial. Pocket remains a selectable local comparison with its
fixed dependency/model hashes. The historical evaluation decision below records
the previous scope; it does not override this newer approval. The native output
continues immediately while a separate outgoing caption client supplies stable
source/translation sentence IDs. Those independently generated text translations
are not a verbatim transcript of native audio and never receive inferred playback
confirmation. See [the bounded cloud trial](CLOUD_CONTINUOUS_TRIAL.md).

The approved experience is Chrome dialing a normal mobile phone: Chinese speech
becomes natural English for the recipient; the recipient's original English is
forwarded to the user with Chinese text alongside it. The return leg does not
require Chinese synthesized speech. Pocket remains the fixed public Michael
voice, with its existing pinned runtime and model hashes.

The repository already contains a dedicated native translation client in
`src/solo/continuous-translation-client.ts`. It uses
`/v1/realtime/translations` and `gpt-realtime-translate`; this is an existing
candidate, not a newly selected default. The current official
[Realtime translation guide](https://developers.openai.com/api/docs/guides/realtime-translation)
describes a continuous stream distinct from the ordinary conversational Realtime
response lifecycle, WebSockets for server media, and PCM16 at 24 kHz.

We retain that adapter and the Pocket routes. Native translated audio may be
compared later, but replacing Pocket would change the approved voice. Provider
transcript deltas alone do not establish paired sentence boundaries or prove
that a recipient heard the audio. Reliable utterance IDs and source associations
must come from the application adapter rather than arrival-order guesses.

Before a later authorized comparison, replay identical approved offline material
through mocks to verify source/translation association, final text revisions,
overlap and out-of-order events, disconnect cleanup and bounded playback queues.
Then separately authorize any provider or real-phone use. Compare numbers,
times, amounts, negation and corrections, first meaningful translated speech,
long-sentence completeness, tail backlog and voice consistency. Record synthesis,
queue and line-mark timing separately from actual mouth-to-ear observations.

No zero-latency, personal-voice cloning, translation-accuracy or real-call
acceptance claim follows from this ADR or the offline UI milestone.
