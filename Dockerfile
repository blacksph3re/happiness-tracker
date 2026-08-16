# Stage 1: build the SPA into the backend's static directory.
FROM node:22-alpine AS frontend
RUN corepack enable
WORKDIR /build
COPY app/package.json app/pnpm-lock.yaml ./app/
# --prod skips devDependencies. Playwright, vitest, the codegen tooling and
# typescript play no part in producing the bundle; `app/package.json` splits on
# exactly that line. Playwright's browser binaries were also the bulk of what
# this step downloaded, and what kept it timing out on a slow connection.
RUN cd app && pnpm install --frozen-lockfile --prod
COPY app ./app
RUN cd app && pnpm build

# Stage 2: resolve the Python dependencies. The `-dev` variant is the only one
# with a shell and a package manager, so everything needing either happens here.
FROM cgr.dev/chainguard/python:latest-dev AS builder
WORKDIR /srv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Without this uv may fetch its own CPython, and the venv would then point at an
# interpreter path that does not exist in the runtime stage below.
ENV UV_PYTHON_DOWNLOADS=never

COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# `/data` is created here because the runtime image has no shell to mkdir with,
# and a volume Docker creates itself would be owned by root. Chainguard runs its
# `-dev` variant as nonroot too, so this one step needs root - in a stage that is
# discarded, and never in the image that ships.
USER root
RUN mkdir -p /data

# Stage 3: the single process that serves both the API and the SPA. Distroless:
# no shell, no package manager, nonroot (65532) by default. That is the point,
# and it is also why `docker exec ... sh` will not work on a running container -
# rebuild the last stage on `:latest-dev` to poke at one.
FROM cgr.dev/chainguard/python:latest
WORKDIR /srv

COPY --chown=65532:65532 backend/ ./
COPY --from=frontend --chown=65532:65532 /build/backend/static ./static
# Copied after the source so that `backend/.venv` on the build host can never
# shadow it, whatever .dockerignore says.
COPY --from=builder --chown=65532:65532 /srv/.venv /srv/.venv
COPY --from=builder --chown=65532:65532 /data /data

ENV PORT=8000 \
    DB_STORAGE=/data/database.db \
    PATH="/srv/.venv/bin:$PATH"
VOLUME /data
EXPOSE 8000

USER 65532

# JWT_SECRET, TOTP_ENCRYPTION_KEY and ADMIN_PASSWORD are deliberately not
# defaulted: the server refuses to start without a signing key or a key for the
# stored second factors, and without an admin password it will not invent one
# for the account it bootstraps.
#
# Exec form with no shell to wrap it, so the interpreter is PID 1 and receives
# SIGTERM directly. The venv's own python is named explicitly rather than
# relying on the base image's ENTRYPOINT.
ENTRYPOINT ["/srv/.venv/bin/python", "entrypoint.py"]
