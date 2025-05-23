# ベースイメージ
FROM node:20-slim

# PuppeteerがChromiumを自動ダウンロードしないようにする
ENV PUPPETEER_SKIP_DOWNLOAD=true

# 必要なライブラリと日本語フォント、Chromiumのインストール
RUN apt-get update && apt-get install -y \
    wget \
    unzip \
    ca-certificates \
    chromium \
    fonts-ipafont-gothic fonts-ipafont-mincho \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libx11-dev libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 \
    libxext6 libxi6 libnss3 libxrandr2 libgbm1 libasound2 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxss1 libxshmfence1 libgtk-3-0 \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 任意の場所からフォントを追加したい場合（例: ipamjm.ttf）
# RUN mkdir -p /usr/share/fonts/truetype/ipafont && \
#    wget -O /usr/share/fonts/truetype/ipafont/IPAexfont.zip https://moji.or.jp/wp-content/ipafont/IPAexfont/IPAexfont00401.zip && \
#    unzip -o /usr/share/fonts/truetype/ipafont/IPAexfont.zip -d /usr/share/fonts/truetype/ipafont && \
#    fc-cache -f -v
COPY fonts/ipamjm.ttf /usr/share/fonts/truetype/. 
RUN  fc-cache -f -v

# 作業ディレクトリ
WORKDIR /app

# package.json / package-lock.json を先にコピーして npm install キャッシュ活用
COPY package*.json ./

# 依存関係のインストール（安全・高速化のためオプションを付ける）
RUN npm install --legacy-peer-deps --no-audit --no-fund

# アプリケーション本体をコピー
COPY . .

# アプリ起動
CMD ["npm", "start"]

