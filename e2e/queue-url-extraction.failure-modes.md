# Queue URL extraction failure modes

Pasted and dropped text becomes queue links through the backend command
`extract_queue_urls`. It splits the text into candidate tokens and runs each
one through `normalize_queue_url`, so the same URL safety rules that guard
`add_to_queue` decide what is accepted. The renderer keeps a per-keystroke
`isValidUrl` check only for instant feedback. It never decides what is queued.

| #   | Failure mode                                                                                           | Required behavior                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Private, loopback, or local host (`http://192.168.1.10/a.mp4`, `http://localhost/a.mp4`)               | Refused. The token is listed in `rejected` and counted in `rejectedCount`. Nothing from it reaches the queue.                                                        |
| 2   | Non-http scheme (`ftp://`, `file://`, `mailto:`)                                                       | Refused. Tokens with `://` are listed in `rejected`. Other schemes are refused and not listed.                                                                       |
| 3   | Same link twice, once with a fragment (`a.mp4?x=1` and `a.mp4?x=1#t=5`)                                | One URL, the fragment removed, kept at the first-seen position.                                                                                                      |
| 4   | Same link pasted twice                                                                                 | One URL. A repeat is not a rejection and is not counted.                                                                                                             |
| 5   | Trailing punctuation (`https://example.com/a.mp4,`)                                                    | Kept as part of the URL, the same as `add_to_queue` treats it. The backend does not guess and strip it.                                                              |
| 6   | Oversized paste (more than 256 KiB of text)                                                            | The command returns a `VALIDATION_ERROR` envelope. Nothing is queued, and the queue and its input stay as they were.                                                 |
| 7   | One oversized token (more than 64 KiB, the per-URL limit) inside an otherwise good paste               | The token is refused and listed in `rejected`. The other links are extracted, so `add_to_queue` does not refuse the whole batch.                                     |
| 8   | Empty, whitespace-only, or comment-only text (`# note`)                                                | An ok envelope with empty `urls`, `rejected`, and a count of 0. The UI shows the existing "No valid http or https links were found." message.                        |
| 9   | Prose with no link (`please grab these`)                                                               | Not link-looking, so not listed and not counted. Only tokens with `://` count as rejected.                                                                           |
| 10  | Renderer and backend disagree (the renderer's `isValidUrl` accepts a private host the backend refuses) | The per-keystroke count may show it. The add path sends only backend `urls` to the queue, and the "ignored as invalid" count comes from the backend `rejectedCount`. |
| 11  | More than 20 refused tokens in one paste                                                               | `rejected` holds the first 20 tokens. `rejectedCount` still reports the full number of refusals.                                                                     |

The E2E scenario `queue-paste-extraction` pastes a mixed block that covers rows
1 to 4, 8 and 9 through the real queue input. It asserts the queue receives
exactly the normalized safe links in first-seen order, and it records the
`extract_queue_urls` result as the repeatable proof.
