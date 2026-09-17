# 06-ambiguous-date - Ambiguous date - "the tenth" with no month

**Before**

| Item | Total | Free today | Tightest day in next 60 |
| --- | --- | --- | --- |
| Camera A | 2 | 2 | 1 |
| Microphone C | 1 | 1 | 1 |
| Tripod B | 3 | 3 | 3 |

| id | item | start | end | qty | status |
| --- | --- | --- | --- | --- | --- |
| seed-camera-a-oct | camera_a | 2026-10-10 | 2026-10-12 | 1 | confirmed |

## Transcript

- **user:** Book the camera for the tenth
- **agent:** Just to be sure about the start date - did you mean 10 October 2026 or 10 November 2026?
- **user:** October
- **agent:** That is available. 1 Camera A, 10 October 2026. Shall I book it?

## Ordered tool calls

1. `check_availability` -> **needs_clarification**
   - args: `{"equipment":"camera_a","start_date_phrase":"tenth","end_date_phrase":"","quantity":1}`
2. `check_availability` -> **available**
   - args: `{"equipment":"camera_a","start_date_phrase":"tenth october","end_date_phrase":"","quantity":1}`
3. `propose_booking` -> **ready**
   - args: `{"hold_token":"<token:eyJlcXVp>"}`

**After**

| Item | Total | Free today | Tightest day in next 60 |
| --- | --- | --- | --- |
| Camera A | 2 | 2 | 1 |
| Microphone C | 1 | 1 | 1 |
| Tripod B | 3 | 3 | 3 |

| id | item | start | end | qty | status |
| --- | --- | --- | --- | --- | --- |
| seed-camera-a-oct | camera_a | 2026-10-10 | 2026-10-12 | 1 | confirmed |

## Database diff

- rows added: 0
- rows removed: 0
