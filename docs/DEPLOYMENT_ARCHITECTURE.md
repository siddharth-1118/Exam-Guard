# ExamGuard Deployment Architecture (Phase 1)

This document describes the deployment topology, component interactions, and hosting boundaries for the ExamGuard Examination Platform.

## 1. System Architecture Diagram

```
+---------------------------------------+
|  Browser / Web Portal (Students/Admins)|
+---------------------------------------+
                    |
                    v
       +-------------------------+
       |   Vercel Cloud Hosting  |
       |  (Static / Next.js SSR) |
       +-------------------------+
                    |
                    v (HTTPS / REST / WSS)
+---------------------------------------------------+
|               API / Backend Service               |
|            (NestJS Server Container)              |
+---------------------------------------------------+
       |                                    |
       v (Prisma TCP)                       v (Redis TCP)
+----------------------+           +----------------------+
|  PostgreSQL Database |           |      Redis Cache     |
|   (Relational DB)    |           |   (PubSub/State)     |
+----------------------+           +----------------------+
       ^                                    ^
       |                                    |
       +-----------------+------------------+
                         |
                         v
       +-----------------------------------+
       |        SFU / Media Daemon         |
       |     (Mediasoup WebRTC Server)     |
       +-----------------------------------+
                         ^
                         | (WebRTC RTP Streams)
                         v
       +-----------------------------------+
       |    Student Electron Desktop App   |
       |   (Context-Isolated Kiosk Client) |
       +-----------------------------------+
                         |
            +------------+------------+
            |                         |
            v                         v
   [Camera + Microphone]      [Screen Capture]
```

---

## 2. Component Boundaries & Hosting Capabilities

### Services Hosted on Vercel
- **Student Web Portal (`apps/student-web`)**: Next.js 15 application hosting student dashboards, exam listings, preflight status displays, and the Desktop Download Center.
- **Admin Web Console (`apps/admin-web`)**: Next.js dashboard for institution administrators to manage question banks, schedule exams, assign student rosters, and review audit logs.
- **Monitor Web Portal (`apps/monitor-web`)**: Next.js proctoring console for human proctors to observe candidate video streams and handle live security alerts.

### Services Requiring Long-Running Server Hosts (Vercel Cannot Host)
- **API Backend Service (`services/api`)**: NestJS application managing JWT authentication, exam state machines, attempt timing, audit logs, and WebSocket control channels. Requires persistent Node.js runtime environment (e.g. AWS ECS, GCP Cloud Run, or Docker VM).
- **PostgreSQL Database**: Primary relational data store for exams, user credentials, attempts, questions, and security event logs. Hosted on AWS RDS, GCP Cloud SQL, or self-hosted PostgreSQL.
- **Redis Cache & Pub/Sub**: High-speed memory store powering WebSocket gateway state, rate limiting, and real-time proctor alert propagation.
- **Mediasoup WebRTC SFU (`services/media`)**: Multi-stream media server for routing live webcam, microphone, and screen share RTP packets. Requires raw UDP/TCP port binding (RTP range `40000-49999`) and persistent UDP transport state impossible on serverless platforms like Vercel.

---

## 3. Communication Protocols

| Source | Destination | Protocol | Purpose |
| :--- | :--- | :--- | :--- |
| Student Desktop App | API Service | HTTPS / WSS | Auth, preflight state, attempt control, heartbeats |
| Student Desktop App | SFU Media Server | WebRTC / ICE | Multi-stream video, audio, and screen transmission |
| Monitor Web Console | API Service | HTTPS / WSS | Real-time candidate roster updates and proctor actions |
| Monitor Web Console | SFU Media Server | WebRTC / ICE | Subscribing to candidate media feeds |
| API Service | PostgreSQL | Prisma TCP | Persistent transaction processing |
| API Service | Redis | ioredis TCP | Rate limiting and event broadcasting |
