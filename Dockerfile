FROM node:20-slim

# 必要なライブラリをインストール（puppeteer用）
RUN apt-get update && apt-get install -y \
  wget ca-certificates fonts-ipafont-gothic fonts-ipafont-mincho \
  fonts-noto-cjk libx11-dev libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
  libxdamage1 libxi6 libxtst6 libnss3 libxrandr2 libasound2 libpangocairo-1.0-0 \
  libatk1.0-0 libgtk-3-0 libgbm-dev libxshmfence-dev \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Puppeteer が Chromium を自動でダウンロードしないように
ENV PUPPETEER_SKIP_DOWNLOAD=true

# アプリ配置
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

# Puppeteer が自動で Chromium のパスを検出できるように
ENV CHROME_BIN=/usr/bin/google-chrome

# puppeteer が Chromium を使うようにパスを通す
RUN npx puppeteer install


# Express のポートを公開
EXPOSE 3000

# Puppeteer を無制限で使うための設定
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# 起動コマンド
CMD ["node", "index.js"]

