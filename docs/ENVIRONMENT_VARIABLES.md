# ExamGuard Environment Variables Reference (Phase 2)

This document provides a comprehensive list of all environment variables required by ExamGuard across local development, staging, and production environments.

> [!CAUTION]
> NEVER commit actual credentials, private keys, JWT secrets, or production passwords to source control. Always populate `.env` locally or via secure cloud secret managers.

---

## 1. Core API Backend (`services/api`)

| Variable | Required | Default / Example | Purpose |
| :--- | :---: | :--- | :--- |
| `NODE_ENV` | Yes | `development` / `production` | Execution mode. Enforces strict secret checks when set to `production`. |
| `PORT` | No | `4000` | HTTP port for NestJS API server. |
| `DATABASE_URL` | Yes | `postgresql://examguard:examguard@localhost:5433/examguard?schema=public` | PostgreSQL connection string used by Prisma ORM. |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection URL for Pub/Sub, rate-limiting, and state caching. |
| `JWT_SECRET` | Yes | `dev-secret-key-min-16-chars` | Secret key used to sign and verify student/proctor/admin JWT tokens. (Min 16 chars in production). |
| `CORS_ORIGIN` | Yes | `http://localhost:3000,http://localhost:3001,http://localhost:3002` | Allowed CORS origins for web portals. Wildcard `*` rejected in production. |
| `STORAGE_DRIVER` | No | `local` / `s3` | Recording storage target. Defaults to `local` storage. |
| `STORAGE_LOCAL_DIR` | No | `./storage/recordings` | Local directory for saved media recordings when `STORAGE_DRIVER=local`. |
| `AWS_S3_BUCKET` | Cond. | `examguard-recordings-prod` | Target bucket name when `STORAGE_DRIVER=s3`. |
| `AWS_ACCESS_KEY_ID` | Cond. | `AKIAIOSFODNN7EXAMPLE` | AWS access key for production S3 storage. |
| `AWS_SECRET_ACCESS_KEY` | Cond. | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` | AWS secret key for production S3 storage. |

---

## 2. SFU Media Service (`services/media`)

| Variable | Required | Default / Example | Purpose |
| :--- | :---: | :--- | :--- |
| `PORT` | No | `4010` | HTTP/WebSocket signaling port for Mediasoup daemon. |
| `ANNOUNCED_IP` | Yes | `127.0.0.1` | Publicly announced IP address for WebRTC ICE candidates. |
| `SFU_ADMIN_KEY` | Yes | `dev-sfu-admin-key-32-chars-long-secret` | Internal authentication key between API service and SFU daemon. |
| `MEDIASOUP_MIN_PORT` | No | `40000` | Minimum UDP port for WebRTC media streams. |
| `MEDIASOUP_MAX_PORT` | No | `49999` | Maximum UDP port for WebRTC media streams. |

---

## 3. Student Web Portal (`apps/student-web`)

| Variable | Required | Default / Example | Purpose |
| :--- | :---: | :--- | :--- |
| `NEXT_PUBLIC_API_URL` | Yes | `http://localhost:4000` | Public REST API URL accessible by the browser. |
| `NEXT_PUBLIC_WS_URL` | Yes | `ws://localhost:4000` | Public WebSocket URL accessible by the browser. |

---

## 4. Student Desktop Client (`apps/student-desktop`)

| Variable | Required | Default / Example | Purpose |
| :--- | :---: | :--- | :--- |
| `EXAMGUARD_API_URL` | No | `http://localhost:4000` | Overrides backend API endpoint in Electron client. |
| `EXAMGUARD_MEDIA_URL` | No | `ws://localhost:4010` | Overrides SFU media signaling endpoint in Electron client. |
