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

FROM base AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM base AS production
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        gobgpd \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist dist
COPY src/schema.sql dist/schema.sql
ENV NODE_ENV=production
ENV GOBGP_BIN=/usr/bin/gobgp
EXPOSE 8080
CMD ["node", "dist/index.js"]
