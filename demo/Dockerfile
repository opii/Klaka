# Kontekst je koren repoa (docker-compose.yaml): demo zavisi od ts/ i sdk/node/.
# Posle podele repoa ovi koraci postaju obične npm zavisnosti.

FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY ts/ ts/
COPY sdk/node/ sdk/node/
COPY demo/ demo/
RUN cd ts && npm ci && npm run build \
 && cd ../sdk/node && npm ci && npm run build \
 && cd ../../demo && npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# node_modules/@ppd/sdk-node je relativan symlink na ../../../sdk/node — ista struktura kao u build-u.
COPY --from=build /build/sdk/node/package.json /app/sdk/node/package.json
COPY --from=build /build/sdk/node/dist/src /app/sdk/node/dist/src
COPY --from=build /build/demo/package.json /app/demo/package.json
COPY --from=build /build/demo/node_modules /app/demo/node_modules
COPY --from=build /build/demo/dist /app/demo/dist
COPY --from=build /build/ts/dist/ppd.min.js /app/demo/public/ppd.min.js
ENV PPD_SNIPPET=/app/demo/public/ppd.min.js NODE_ENV=production
WORKDIR /app/demo
USER node
CMD ["node", "dist/server.js"]
