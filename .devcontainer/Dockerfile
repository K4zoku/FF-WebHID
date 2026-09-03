FROM node:22-bookworm-slim

USER root

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        ca-certificates \
        curl \
        git \
        build-essential \
        pkg-config \
        libudev-dev \
        patch \
        zip \
    && rm -rf /var/lib/apt/lists/*

USER node

ENV PATH="/home/node/.cargo/bin:${PATH}"

RUN curl --proto '=https' --tlsv1.2 --fail --silent --show-error https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain stable \
            --component rustfmt,clippy

WORKDIR /opt/ff-webhid
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts

USER root

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps firefox \
    && chmod -R a+rX /ms-playwright \
    && chown -R node:node /ms-playwright

USER node
WORKDIR /workspaces/ff-webhid
