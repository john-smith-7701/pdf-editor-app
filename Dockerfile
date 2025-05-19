# ベースイメージとして Node.js slim を使用
FROM node:20-slim

# 必要なツールと日本語フォント、Puppeteer の依存パッケージをインストール
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-ipafont-gothic fonts-ipafont-mincho \
    fonts-noto-cjk \
    libx11-dev libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 \
    libxext6 libxi6 libnss3 libxrandr2 libgbm1 libasound2 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxss1 libxshmfence1 libgtk-3-0 \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 作業ディレクトリを作成
WORKDIR /app

# package.json と package-lock.json のみを最初にコピー（キャッシュ有効活用）
COPY package*.json ./

# npm install の実行
RUN npm install

# 残りのアプリケーションコードをコピー
COPY . .

# 必要であればビルド（ReactやTypeScriptの場合など）
# RUN npm run build

# アプリの起動
CMD ["npm", "start"]
