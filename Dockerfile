FROM node:20-slim

WORKDIR /app

# Instalar solo dependencias de produccion primero (mejor cache)
COPY package*.json ./
RUN npm install --omit=dev --no-fund --no-audit

# Copiar el resto del codigo
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
