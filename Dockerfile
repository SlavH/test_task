FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime

RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/var/data

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY --from=build /app/agent ./agent
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/web ./web
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p /var/data && chown -R node:node /app /var/data

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/main.mjs"]
