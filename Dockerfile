FROM node:24-bookworm-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig*.json vite.config.ts ./
COPY src ./src
COPY scripts/ssh-agent-install-local.sh scripts/ssh-agent-install-remote.sh scripts/ssh-agent-probe.sh ./scripts/
RUN npm run build

FROM rust:bookworm AS backend
WORKDIR /build
COPY agent-cli/Cargo.toml agent-cli/Cargo.lock ./agent-cli/
COPY agent-cli/src ./agent-cli/src
COPY src-tauri/src ./src-tauri/src
RUN cargo build --locked --release --manifest-path agent-cli/Cargo.toml \
    --features web --bin yterminal-agent --bin yterminal-web

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git openssh-client procps curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash --uid 1000 yterminal

COPY --from=frontend /build/dist /opt/yterminal/dist
COPY --from=backend /build/agent-cli/target/release/yterminal-agent /usr/local/bin/
COPY --from=backend /build/agent-cli/target/release/yterminal-web /usr/local/bin/
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/yterminal-entrypoint

ENV HOME=/home/yterminal \
    SHELL=/bin/bash \
    YTERMINAL_WEB_ASSETS=/opt/yterminal/dist \
    YTERMINAL_WEB_LISTEN=0.0.0.0:8080
USER yterminal
WORKDIR /home/yterminal
EXPOSE 8080
HEALTHCHECK CMD curl -fsS http://127.0.0.1:8080/ >/dev/null
ENTRYPOINT ["/usr/local/bin/yterminal-entrypoint"]
