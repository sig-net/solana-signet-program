FROM ubuntu:24.04

# Install Node.js 20 and Yarn
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && corepack enable \
    && corepack prepare yarn@1.22.22 --activate

# Install Rust, Solana and Anchor
RUN curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash

WORKDIR /workspace