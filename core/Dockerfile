# dev   — Rust toolchain za razvoj (docker compose run --rm rust cargo …)
# build — prevodi sve binarne fajlove
# (bez imena) — mala runtime slika sa ppd-collector, ppd-api, ppd-engine

FROM rust:1.88-bookworm AS dev
RUN rustup component add clippy rustfmt

FROM dev AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release \
 && mkdir /out \
 && cp target/release/ppd-collector target/release/ppd-api target/release/ppd-engine /out/

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 ppd
COPY --from=build /out/ /usr/local/bin/
USER ppd
