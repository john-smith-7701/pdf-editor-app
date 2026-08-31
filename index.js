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

app.use(cors());
app.use(express.json());

process.on('uncaughtException', (err) => {
  console.log('Uncaught Exception:', err);
  process.exit(1);
});

// 📝 Puppeteer でクライアントデータを指定位置に描画し PDF 化
async function generatePdfFromHtml(textItems, width, height, isLandscape, rotationAngle) {
    const browser = await puppeteer.launch({
	 executablePath: '/usr/bin/chromium',
         headless: true,
         args: [
		"--disable-crash-reporter",
     		"--disable-gpu",
      		"--disable-dev-shm-usage",
      		"--disable-setuid-sandbox",
      		"--no-first-run",
      		"--no-sandbox",
      		"--no-zygote",
      		"--single-process",
      		"--proxy-server='direct://'",
      		"--proxy-bypass-list=*",
      		"--font-render-hinting=none",
    //        '-font-config-file=/usr/share/fonts/truetype/ipafont/ipamjm.ttf' 
        ]
     });
//    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();

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
            font-family: 'customEUDC','DWPIexMincho', 'Arial', sans-serif;
            ${prop}
            ">${item['text']}</div>`;
	}
    }).join("\n");

    const htmlContent = `
    <html>
    <head>
        <style>
            body {
                font-family: 'DWPIexMincho';
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

    await page.addStyleTag({
    content: `
        body {
            font-family: 'customEUDC','IPAmjMincho', sans-serif !important;
        }
    `
    });

    await page.setContent(htmlContent, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
        width: `${isLandscape ? height : width}px`,
        height: `${isLandscape ? width : height}px`,
        printBackground: true,
        landscape: true,
        format: "a2",
    });
    await browser.close();
    return pdfBuffer;
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
        adjustedX = 0;
        adjustedY = originalPage.getWidth();
    } else if (rotationAngle === 180) {
        adjustedX = originalPage.getWidth();
        adjustedY = originalPage.getHeight();
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

        console.log(`${new Date()} : Processing PDF - Width: ${width}, Height: ${height}, isLandscape: ${isLandscape}, Rotation: ${rotationAngle}`);

        // 📝 クライアントのデータを HTML → PDF
        const overlayPdfBuffer = await generatePdfFromHtml(texts, width, height, isLandscape, rotationAngle);

        // 📝 元の PDF に適用（重ねる）
        const editedPdfBytes = await mergePdfs(req.file.path, overlayPdfBuffer, rotationAngle);

        // 📌 クライアントに送信
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="edited.pdf"');
        res.setHeader("Content-Length", editedPdfBytes.length);
        res.send(Buffer.from(editedPdfBytes));

        console.log(`${new Date()} : End`);
        fs.unlinkSync(req.file.path);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Error processing PDF." });
    }
});
app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PDF 編集 Ver.1.2</title>
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

app.listen(port, () => console.log(`Server running on port ${port}`));

