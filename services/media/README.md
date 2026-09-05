# @examguard/media — WebRTC / SFU (Phase 4B — NOT YET IMPLEMENTED)

**Status:** Designed. Placeholder contract. Phase 4A built the media-session
*control plane* inside the API (`services/api/src/media/`: REST session CRUD +
authenticated WebSocket gateway). This service is the future SFU/media plane.

- LiveKit (or equivalent SFU) cluster; media never traverses the API server (§35).
- Student publishes `camera`, `audio`, `screen` tracks to room `attempt-{attemptId}`.
- Monitors subscribe with adaptive quality: focused student at HD, grid tiles at low bitrate/thumbnail resolution (§12, §35). Initial 100-student target fits one SFU node; scale-out documented in `docs/DEPLOYMENT.md`.
- Phase 4B: real SFU process (mediasoup), media tokens, RTP transport. Nothing here is implemented or runnable yet.
- Integration: `docker-compose.yml` may gain a `media` profile in 4B.
