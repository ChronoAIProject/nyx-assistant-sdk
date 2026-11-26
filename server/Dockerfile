FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node server.mjs voice.mjs ./
USER 1000:1000
EXPOSE 8080
CMD ["node", "server.mjs"]
