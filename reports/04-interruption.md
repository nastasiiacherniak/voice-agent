# 04-interruption - Interruption - cuts in during the read-back and switches to the microphone

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

- **user:** Can I have a tripod from the 14th to the 16th of October 2026
- **agent:** That is available. 1 Tripod B, 14–16 October 2026. Shall I book it?
- **user (interrupting):** actually make it the microphone instead
- **user:** Actually make it the microphone instead
- **agent:** That is available. 1 Microphone C, 14–16 October 2026. Shall I book it?
- **user:** Yes, confirm
- **agent:** Done. 1 Microphone C, 14–16 October 2026. Your reservation number is res_6cbcac09.

## Ordered tool calls

1. `check_availability` -> **available**
   - args: `{"equipment":"tripod_b","start_date_phrase":"14th","end_date_phrase":"16th of october 2026","quantity":1}`
2. `propose_booking` -> **ready**
   - args: `{"hold_token":"<token:eyJlcXVp>"}`
3. `check_availability` -> **available**
   - args: `{"equipment":"mic_c","start_date_phrase":"14th","end_date_phrase":"16th of october 2026","quantity":1}`
4. `propose_booking` -> **ready**
   - args: `{"hold_token":"<token:eyJlcXVp>"}`
5. `confirm_booking` -> **confirmed**
   - args: `{"hold_token":"<token:eyJlcXVp>"}`

**After**

| Item | Total | Free today | Tightest day in next 60 |
| --- | --- | --- | --- |
| Camera A | 2 | 2 | 1 |
| Microphone C | 1 | 1 | 0 |
| Tripod B | 3 | 3 | 3 |

| id | item | start | end | qty | status |
| --- | --- | --- | --- | --- | --- |
| seed-camera-a-oct | camera_a | 2026-10-10 | 2026-10-12 | 1 | confirmed |
| res_6cbcac09 | mic_c | 2026-10-14 | 2026-10-16 | 1 | confirmed |

## Database diff

- rows added: 1
  - `res_6cbcac09` mic_c 2026-10-14 to 2026-10-16 x1
- rows removed: 0
