FROM node:20

# 1) Install Chromium + required libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnspr4 libnss3 \
    ca-certificates fonts-liberation \
    libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 \
    libpangocairo-1.0-0 libpango-1.0-0 \
    libgtk-3-0 \
    libx11-6 libxcb1 libxext6 libxshmfence1 \
 && rm -rf /var/lib/apt/lists/*

# 2) Tell Puppeteer to NOT download its own Chrome
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer
RUN mkdir -p /home/node/.cache/puppeteer && chown -R node:node /home/node/.cache

WORKDIR /app
COPY package*.json .
RUN npm ci --no-audit --no-fund
RUN npm install
COPY . .
RUN npm run build
# USER node
CMD ["npm", "start"]
