FROM node:22-alpine

WORKDIR /app

# Support both build contexts:
# 1) repo root (contains apps/api/...)
# 2) apps/api root (contains package.json + src/)
COPY . .

RUN if [ -f "apps/api/package.json" ]; then \
      cd apps/api && npm install --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

ENV NODE_ENV=production
EXPOSE 4000

CMD ["sh", "-c", "if [ -f apps/api/package.json ]; then cd apps/api && npm run start; else npm run start; fi"]
