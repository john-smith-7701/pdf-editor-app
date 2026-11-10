const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { PDFDocument, degrees } = require('pdf-lib');
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ dest: "uploads/" });
const port = process.env.PORT || 8080;
const fontColor = 'red'; 
const fontFamily = 'DWPIexMincho';
// GJTYMincho に無い記号(☐☑ 等)の代替フォント(Dockerfile で fonts-dejavu-core をインストール)
const symbolFontFamily = "'DejaVu Sans'";

app.use(cors());
app.use(express.json());

process.on('uncaughtException', (err) => {
  console.log('Uncaught Exception:', err);
  process.exit(1);
});

// ===== Chromium の共有と同時実行数の制限 =====
// 以前はリクエスト毎に Chromium を起動・終了していたため、同時にリクエストが来ると
// 起動タイムアウト(Timed out waiting for WS endpoint)・setContent タイムアウト・
// TargetCloseError が発生し、PHP 側で何も書かれていない PDF ができていた。
//  ・Chromium は 1 つだけ起動して使い回す(リクエスト毎は newPage / page.close のみ)
//  ・同時に描画するページ数を MAX_CONCURRENCY に制限し、超えた分は順番待ち
//  ・Chromium が落ちた場合は次のリクエストで自動的に起動し直す
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.PDF_EDIT_MAX_CONCURRENCY || '2', 10) || 2);
const RENDER_TIMEOUT_MS = Math.max(1000, parseInt(process.env.PDF_EDIT_RENDER_TIMEOUT_MS || '60000', 10) || 60000);

let browserPromise = null;
let currentBrowser = null;

function launchBrowser() {
    // Puppeteer が自動管理する Chromium のパスを取得
    const defaultExecutable = puppeteer.executablePath();
    return puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || defaultExecutable,
        headless: true,
        protocolTimeout: RENDER_TIMEOUT_MS * 2,
        args: [
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--disable-setuid-sandbox",
            "--no-first-run",
            "--no-sandbox",
            "--no-zygote",
            // "--single-process" は複数ページを同時に扱うと不安定になるため使わない
            "--proxy-server='direct://'",
            "--proxy-bypass-list=*",
            "--font-render-hinting=none",
        ]
    });
}

function getBrowser() {
    if (currentBrowser && !currentBrowser.connected) {
        // 落ちている場合は作り直す
        currentBrowser = null;
        browserPromise = null;
    }
    if (!browserPromise) {
        browserPromise = launchBrowser().then((browser) => {
            currentBrowser = browser;
            const proc = browser.process();
            console.log(`${new Date()} : Chromium launched (pid=${proc ? proc.pid : '-'})`);
            browser.on('disconnected', () => {
                console.log(`${new Date()} : Chromium disconnected`);
                if (currentBrowser === browser) {
                    currentBrowser = null;
                    browserPromise = null;
                }
            });
            return browser;
        }).catch((err) => {
            browserPromise = null;
            throw err;
        });
    }
    return browserPromise;
}

// 同時実行数の制限(セマフォ)
let activeCount = 0;
const waitQueue = [];
function acquireSlot() {
    if (activeCount < MAX_CONCURRENCY) {
        activeCount++;
        return Promise.resolve();
    }
    return new Promise((resolve) => waitQueue.push(resolve));
}
function releaseSlot() {
    const next = waitQueue.shift();
    if (next) {
        next();          // 枠をそのまま次の待ちに渡す
    } else {
        activeCount--;
    }
}

// 📝 Puppeteer でクライアントデータを指定位置に描画し PDF 化
async function generatePdfFromHtml(textItems, width, height, isLandscape, rotationAngle) {
    let textDivs = textItems.map((item) => {
        let prop = ``;
        for(k in item){
            if(k != 'text' && k != 'image'){
                prop += `${k}: ${item[k]};
                        `;
            }
        }
        if (item['image']) {
            // ★ 画像を描画
            return `<img src="data:image/png;base64,${item['image']}" style="
                position: absolute;
                ${prop}
                max-width: 100%;
                max-height: 100%;
            " />`;
        } else {
	    return `<div style="
            position: absolute;
            color: ${fontColor};
            font-family: ${fontFamily}, 'IPAmjMincho', ${symbolFontFamily}, 'Arial', sans-serif;
            ${prop}
            ">${item['text']}</div>`;
	}
    }).join("\n");

    const htmlContent = `
    <html>
    <head>
        <style>
            body {
                font-family: ${fontFamily}, 'IPAmjMincho', ${symbolFontFamily}, sans-serif !important;
                font-size: 16px;
                margin: 0;
                position: relative;
            }
        </style>
    </head>
    <body>
        ${textDivs}
    </body>
    </html>`;

    await acquireSlot();
    let page = null;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        page.setDefaultTimeout(RENDER_TIMEOUT_MS);

        // 外部リソースは無い(画像は data URI)ため networkidle0(最低 500ms 待ち)ではなく load で十分。
        // フォントの読み込み完了は document.fonts.ready で待つ。
        await page.setContent(htmlContent, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
        await page.evaluate(() => document.fonts.ready.then(() => true));

        const pdfBuffer = await page.pdf({
            width: `${isLandscape ? height : width}px`,
            height: `${isLandscape ? width : height}px`,
            printBackground: true,
            landscape: true,
            format: "a1",
            timeout: RENDER_TIMEOUT_MS,
        });
        return pdfBuffer;
    } finally {
        if (page) {
            await page.close().catch(() => {});
        }
        releaseSlot();
    }
}

// Chromium が落ちた等で失敗した場合は 1 回だけやり直す
async function generatePdfFromHtmlWithRetry(textItems, width, height, isLandscape, rotationAngle) {
    try {
        return await generatePdfFromHtml(textItems, width, height, isLandscape, rotationAngle);
    } catch (err) {
        console.log(`${new Date()} : generatePdfFromHtml failed, retry once:`, err && err.message ? err.message : err);
        if (currentBrowser && !currentBrowser.connected) {
            currentBrowser = null;
            browserPromise = null;
        }
        return await generatePdfFromHtml(textItems, width, height, isLandscape, rotationAngle);
    }
}

// 📝 PDF-lib で元の PDF に Puppeteer で作成した PDF を重ねる
async function mergePdfs(originalPdfPath, overlayPdfBuffer, rotationAngle) {
    const originalPdfBytes = fs.readFileSync(originalPdfPath);
    const originalPdfDoc = await PDFDocument.load(originalPdfBytes);
    const overlayPdfDoc = await PDFDocument.load(overlayPdfBuffer);

    const originalPage = originalPdfDoc.getPages()[0];
    const overlayPage = overlayPdfDoc.getPages()[0];

    const [embeddedPage] = await originalPdfDoc.embedPdf(overlayPdfBuffer);

    let adjustedX = 0;
    let adjustedY = 0;  //originalPage.getHeight(); // **左上基準に修正**

    if (rotationAngle === 90) {
        adjustedX = overlayPage.getHeight();
        adjustedY = 0;
    } else if (rotationAngle === 270) {
        // 重ね合わせ層の左上が表示上の左上に来るよう、重ね合わせ層の高さを使って位置を求める
        adjustedX = originalPage.getWidth() - overlayPage.getHeight();
        adjustedY = originalPage.getHeight();
    } else if (rotationAngle === 180) {
        adjustedX = originalPage.getWidth();
        adjustedY = overlayPage.getHeight();
    } else {
        adjustedX = 0;
        adjustedY = 0;
    }

    if ( overlayPage.getWidth() > overlayPage.getHeight() && rotationAngle == 0){
	adjustedY = originalPage.getHeight() - overlayPage.getHeight();  // -247; 
        console.log(`${new Date()} : Processing PDF - overlay: ${overlayPage.getHeight()}, original: ${originalPage.getHeight()}`);

    }
    originalPage.drawPage(embeddedPage, {
        x: adjustedX,
        y: adjustedY,
        //width: originalPage.getWidth(),
        //height: originalPage.getHeight(),
        rotate: degrees(rotationAngle),
    });

    return await originalPdfDoc.save();
}

// 📌 クライアントのデータを Puppeteer で PDF 化 → PDF-lib で元のPDFに重ねる
app.post("/edit-pdf", upload.single("pdf"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded." });
        }

        const { texts } = JSON.parse(req.body.json); // **JSON の配列を取得**
        if (!Array.isArray(texts) || texts.length === 0) {
            return res.status(400).json({ error: "Invalid text array." });
        }

        // 📝 元の PDF のサイズを取得
        const originalPdfBytes = fs.readFileSync(req.file.path);
        const originalPdfDoc = await PDFDocument.load(originalPdfBytes);
        const originalPage = originalPdfDoc.getPages()[0];
        const width = originalPage.getWidth();
        const height = originalPage.getHeight();

        // 📝 横向き（landscape）かどうかを判定
        const rotationAngle = originalPage.getRotation().angle || 0;
        const isLandscape = rotationAngle === 90;

        console.log(`${new Date()} : Processing PDF - Width: ${width}, Height: ${height}, isLandscape: ${isLandscape}, Rotation: ${rotationAngle}, active: ${activeCount}/${MAX_CONCURRENCY}, waiting: ${waitQueue.length}`);

        // 📝 クライアントのデータを HTML → PDF
        const overlayPdfBuffer = await generatePdfFromHtmlWithRetry(texts, width, height, isLandscape, rotationAngle);

        // 📝 元の PDF に適用（重ねる）
        const editedPdfBytes = await mergePdfs(req.file.path, overlayPdfBuffer, rotationAngle);

        // 📌 クライアントに送信
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="edited.pdf"');
        res.setHeader("Content-Length", editedPdfBytes.length);
        res.send(Buffer.from(editedPdfBytes));

        console.log(`${new Date()} : End`);
    } catch (error) {
        console.log(error);
        if (!res.headersSent) {
            res.status(500).json({ error: "Error processing PDF." });
        }
    } finally {
        // エラー時もアップロードされた一時ファイルを削除する
        if (req.file) {
            fs.promises.unlink(req.file.path).catch(() => {});
        }
    }
});
app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PDF 編集 Ver.1.2.001</title>
            <script>
                async function sendForm(event) {
                    event.preventDefault();

                    const formData = new FormData();
		    const fileInput = document.getElementById("pdf");
                    formData.append("pdf", fileInput.files[0]);

                    const texts = [];
                    // テキスト項目をまとめる
                    for (let i = 1; i <= 3; i++) {
                        const text = document.getElementById("text" + i).value;
                        const x = document.getElementById("x" + i).value;
                        const y = document.getElementById("y" + i).value;
                        const f = document.getElementById("f" + i).value;
                        if (text.trim() !== "") {
                            texts.push({ text, left: parseInt(x), top: parseInt(y), 'font-size': parseInt(f)});
                        }
                        const free = document.getElementById("free").value;
                        if(free.trim() !== ""){
                            texts.push(JSON.parse(free));
                        }
                    }

                    // 画像項目をまとめる
                    const imageFiles = document.getElementById("images").files;
                    for (let i = 0; i < imageFiles.length; i++) {
                      const file = imageFiles[i];
                      const base64 = await toBase64(file);

                      const x = document.getElementById(\`imageX\${i}\`).value;
                      const y = document.getElementById(\`imageY\${i}\`).value;
                      const width = document.getElementById(\`imageWidth\${i}\`).value;
                      const height = document.getElementById(\`imageHeight\${i}\`).value;

                      texts.push({
                        image: base64.split(',')[1],
                        left: parseInt(x),
                        top: parseInt(y),
                        width: width + "px",
                        height: height + "px"
                      });
                    }

                    formData.append("json", JSON.stringify({ texts }));
                    console.log(JSON.stringify({ texts }));

                    fetch("edit-pdf", {
                        method: "POST",
                        body: formData
                    })
                    .then(response => response.blob())
                    .then(blob => {
                        const url = window.URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "edited.pdf";
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                    })
                    .catch(error => console.error("Error:", error));
                }

                function toBase64(file) {
                  return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.readAsDataURL(file);
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = error => reject(error);
                  });
                }

                function updateImageInputs() {
                  const files = document.getElementById("images").files;
                  const container = document.getElementById("imageInputs");
                  container.innerHTML = "";

                  for (let i = 0; i < files.length; i++) {
                    const div = document.createElement("div");
                    div.innerHTML = \`
                      <strong>\${files[i].name}</strong><br>
                      X: <input type="number" id="imageX\${i}" value="0" style="width:80px;"> 
                      Y: <input type="number" id="imageY\${i}" value="0" style="width:80px;"> 
                      Width: <input type="number" id="imageWidth\${i}" value="100" style="width:80px;"> 
                      Height: <input type="number" id="imageHeight\${i}" value="100" style="width:80px;">
                      <br><br>
                    \`;
                    container.appendChild(div);
                  }
                }
            </script>
        </head>
        <body>
            <h2>PDF に複数のテキストを追加</h2>
            <form onsubmit="sendForm(event)">
                <input type="file" id="pdf" name="pdf" accept="application/pdf" required><br><br>

                ${lineText()}
                <textarea id="free" name="free" rows="10" cols="40">
{
"top":120,
"left":50,
"text":"𠀋（異体字テスト）「葛󠄂城市」「葛󠄁飾区」",
"width":"80",
"height":"250",
"writing-mode": "vertical-rl",
"color":"#00F",
"background":"#FFF",
"overflow-wrap": "break-word"
}
                </textarea>
                <h3>画像を追加</h3>
                <input type="file" id="images" multiple accept="image/*" onchange="updateImageInputs()"><br><br>
                <div id="imageInputs"></div>

                <button type="submit">送信してPDF作成</button>
            </form>
        </body>
        </html>
    `);
    function lineText(){
        let txt = '';
        const values = ['','𠀋（異体字テスト）「葛󠄂城市」「葛󠄁飾区」','辻󠄂髙㈱辻󠄀🍺🍣鶹こんにちは、𠮷野家','テキスト'];
        for(i=1;i<4;i++){
            txt += `
                <label>テキスト ${i}:</label>
                <input type="text" id="text${i}" name="text${i}" value="${values[i]}" required>
                X: <input type="number" id="x${i}" name="x${i}" value="${(i-1)*100}" required>
                Y: <input type="number" id="y${i}" name="y${i}" value="${(i-1)*100}" required>
                font-size: <input type="number" id="f${i}" name="f${i}" value="${16-((i-1)*2)}" required>
                <br><br>
                `;
        }
        return txt;
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port} (max concurrency: ${MAX_CONCURRENCY})`);
    // 起動時に Chromium を立ち上げておく(初回リクエストを速くする)
    getBrowser().catch((err) => console.log(`${new Date()} : Chromium launch failed:`, err));
});

// コンテナ停止時に Chromium を終了する
async function shutdown(signal) {
    console.log(`${new Date()} : ${signal} received, shutting down`);
    try {
        if (currentBrowser) {
            await currentBrowser.close();
        }
    } catch (e) {}
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

