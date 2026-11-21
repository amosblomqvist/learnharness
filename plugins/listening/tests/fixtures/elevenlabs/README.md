# ElevenLabs reply fixtures

Real ElevenLabs replies, recorded from the live service, so the tests check the error shapes ElevenLabs actually sends rather than the ones we expect. Each file holds the HTTP status, the content type and the JSON body. Request IDs are replaced with zeros and request paths show `{voice_id}`; the reply bodies are otherwise unedited. No file contains an API key or account data.

| File | Request | What it shows |
| --- | --- | --- |
| `invalid-api-key.json` | `GET /v1/models` with a malformed key | A wrong key can come back as **400**, not only 401. |
| `revoked-api-key.json` | `GET /v1/models` with a revoked key | 401 `invalid_api_key`. |
| `missing-permission.json` | `GET /v1/user/subscription` with a key that lacks "User: Read" | 401 `missing_permissions`. The shape is the same for every permission. |
| `unknown-voice.json` | `POST /v1/text-to-speech/{voice_id}` with a voice ID that doesn't exist | 404 `voice_not_found`. |
| `unknown-model.json` | `POST /v1/text-to-speech/{voice_id}` with a model ID that doesn't exist | 400 `model_not_found`. |
| `models.json` | `GET /v1/models` | The live model list. |
| `quota-exceeded.json` | Not recorded | Running out of credit can't be recorded on purpose. Its shape comes from the ElevenLabs help article named in the file. |

To record a reply again, make the same request with your own key, replace `request_id` with zeros, and check that the body has no key or account data.
