# Stage 1: build the SPA into the backend's static directory.
FROM node:22-alpine AS frontend
RUN corepack enable
WORKDIR /build
COPY app/package.json app/pnpm-lock.yaml ./app/
RUN cd app && pnpm install --frozen-lockfile
COPY app ./app
RUN cd app && pnpm build

# Stage 2: the single process that serves both the API and the SPA.
FROM python:3.11-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /srv

COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend/ ./
COPY --from=frontend /build/backend/static ./static

ENV PORT=8000 \
    DB_STORAGE=/data/database.db \
    PATH="/srv/.venv/bin:$PATH"
VOLUME /data
EXPOSE 8000

# JWT_SECRET is deliberately not defaulted: without one the server generates a
# random key at boot, so every restart signs everybody out.
CMD ["sh", "-c", "alembic upgrade head && uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
