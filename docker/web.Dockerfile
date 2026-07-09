# =============================================================================
# Ceiba NL->SQL — Next.js web (dev) image
# =============================================================================
# The TS app / API gateway (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.2). Dev-
# oriented: the repo is bind-mounted and `next dev` runs with hot reload. This
# is the ONLY public ingress; it reaches the `nl2sql` service over the private
# compose network at http://nl2sql:8088.
# =============================================================================
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching. The bind-mount in compose overlays the
# source; node_modules stays in the image layer (see the compose volume note).
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
