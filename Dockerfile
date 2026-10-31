# Panic Station для платформы Zarya Boardgames: один файл Node без зависимостей + картинки и правила.
FROM node:20-alpine
WORKDIR /app
COPY PanicStation/panic_station.js ./
COPY PanicStation/assets/img ./assets/img
COPY PanicStation/assets/docs ./assets/docs
ENV PORT=3001 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 3001
USER node
CMD ["node", "panic_station.js"]
