FROM ubuntu:24.04

# Install Node.js 20 and Yarn
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g yarn

# Install Rust, Solana and Anchor
RUN curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash

# Setup Anchor
RUN avm install 0.31.1
RUN avm use 0.31.1

WORKDIR /workspace