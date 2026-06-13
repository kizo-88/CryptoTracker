# CryptoTracker backend (Express + autotraders + quant engine)
FROM node:20-alpine

WORKDIR /app

# install deps first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev

# app source
COPY server ./server
COPY public ./public

ENV PORT=3000
EXPOSE 3000

# paper-trading state persists here — mount a volume in compose
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
