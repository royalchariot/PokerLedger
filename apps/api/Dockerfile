FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY apps/web/package*.json ./apps/web/

RUN npm install

COPY . .

ENV NODE_ENV=production
WORKDIR /app/apps/api

EXPOSE 4000

CMD ["npm", "run", "start"]
