FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY . .
RUN npm run build

FROM node:20-alpine
RUN apk add --no-cache gobgp
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY src/schema.sql dist/src/schema.sql
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
