FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server.mjs .
USER 1000:1000
EXPOSE 8080
CMD ["node", "server.mjs"]
