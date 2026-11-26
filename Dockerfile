FROM denoland/deno:bin AS deno-bin
FROM debian:bookworm-slim

RUN apt-get update -qq && \
  apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    subversion && \
  rm -rf /var/lib/apt/lists/* && \
  git config --system --add safe.directory '*'

COPY --from=deno-bin /deno /usr/local/bin/deno

ENV DENO_DIR=/deno-dir
WORKDIR /opt/wpplugins-cache

COPY deno.json deno.lock ./
COPY src/ ./src/

RUN deno cache src/*.ts && rm -rf /opt/wpplugins-cache
WORKDIR /github/workspace
