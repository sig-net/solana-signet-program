FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    pkg-config \
    libssl-dev \
    libudev-dev \
    libclang-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 and Yarn
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g yarn@1.22.22

# Install Rust
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    --default-toolchain stable \
    --profile minimal \
    && rustup --version \
    && cargo --version \
    && rustc --version

# Install Solana CLI
ENV PATH="/root/.local/share/solana/install/active_release/bin:$PATH"
RUN sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.15/install)" \
    && solana --version

# Install AVM and Anchor
ENV PATH="/root/.avm/bin:$PATH"
RUN cargo install --git https://github.com/coral-xyz/anchor avm --force --locked \
    && avm --version \
    && avm install 0.31.1 \
    && avm use 0.31.1 \
    && anchor --version

# Verify all installations
RUN node --version \
    && npm --version \
    && yarn --version \
    && rustc --version \
    && cargo --version \
    && solana --version \
    && avm --version \
    && anchor --version

WORKDIR /workspace

# Set shell to bash for better compatibility
SHELL ["/bin/bash", "-c"]