# Infrastructure — Docker

Dev environments live in `docker-compose.yml` at the repo root (Postgres + Redis today; `media`/`ai` profiles arrive with their phases). The `services/api/Dockerfile` builds the API container. Kubernetes manifests and Terraform for production are a Phase 7 task (see `docs/DEPLOYMENT.md`).