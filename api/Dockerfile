FROM ubuntu:latest AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    git \
    make \
    g++ \
    python3 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY . .
RUN npm run build

FROM base AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends tar \
    && rm -rf /var/lib/apt/lists/*
ARG GOBGP_VERSION=3.15.0
RUN curl -fsSL "https://github.com/osrg/gobgp/releases/download/v${GOBGP_VERSION}/gobgp_${GOBGP_VERSION}_linux_amd64.tar.gz" -o /tmp/gobgp.tar.gz \
    && tar -xzf /tmp/gobgp.tar.gz -C /tmp \
    && install -m 0755 /tmp/gobgp /usr/local/bin/gobgp \
    && install -m 0755 /tmp/gobgpd /usr/local/bin/gobgpd \
    && rm -rf /tmp/gobgp* \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY src/schema.sql dist/schema.sql
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
