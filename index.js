const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');
const Datastore = require('@seald-io/nedb');
const FormData = require('form-data');
const Tesseract = require('tesseract.js');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

/* ================= DB ================= */
const db = new Datastore({ filename: 'tasks.db', autoload: true });

/* ================= BOT & SERVER ================= */
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.get('/', (req, res) => res.send("OK"));
app.listen(process.env.PORT || 7860, '0.0.0.0');

/* ================= GLOBAL CONFIGS ================= */
let queue = [];
let activeWorkers = 0;
const MAX_CONCURRENT_TASKS = 2; // Kept low for Render CPU/RAM stability

/* ================= BOT START ================= */
bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log("🚀 Bot is live with Puppeteer + OCR Price Extraction!");
    cleanupOldTasks();
}).catch(err => console.error("❌ Launch Error:", err.message));

setInterval(cleanupOldTasks, 60 * 60 * 1000);

function cleanupOldTasks() {
    const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
    db.remove({ timestamp: { $lt: threeHoursAgo } }, { multi: true }, (err, numRemoved) => {
        if (numRemoved) console.log(`🧹 Cleaned up ${numRemoved} old tasks from DB.`);
    });
}

/* ================= DEBUG / SCREENSHOT SENDER ================= */
async function sendDebugPayload(imageBuffer, asin, msgId, url) {
    try {
        console.log(`📸 Uploading OCR Screenshot Log for ASIN: ${asin || msgId}...`);
        
        const formData = new FormData();
        formData.append('asin', asin || 'unknown');
        formData.append('msgId', String(msgId));
        formData.append('target_url', url);
        formData.append('file', imageBuffer, { filename: `screenshot_${msgId}.png` });

        const uploadUrl = 'https://lootdealtricky.in/x/render_error/';
        
        await axios.post(uploadUrl, formData, {
            headers: {
                ...formData.getHeaders(),
                'User-Agent': 'Render-Bot-OCR-Worker'
            },
            timeout: 15000
        });
        console.log(`✅ Screenshot Log Sent Successfully!`);
    } catch (err) {
        console.log(`⚠️ Debug Upload Failed: ${err.message}`);
    }
}

/* ================= UTILS & PARSERS ================= */

async function resolveUrl(url) {
    try {
        const response = await axios.get(url, {
            maxRedirects: 10,
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)' },
            timeout: 10000
        });
        return response.request.res.responseUrl || url;
    } catch (e) {
        return e.response?.request?.res?.responseUrl || url;
    }
}

function extractPostPrice(text) {
    let matches = [...text.matchAll(/₹\s?(\d{2,6})/g)];
    if (matches.length > 0) return Math.min(...matches.map(m => parseInt(m[1])));
    let match = text.match(/(\d{2,6})\s?\/-/);
    if (match) return parseInt(match[1]);
    const firstLine = text.split('\n')[0];
    match = firstLine.match(/(\d{2,6})/);
    if (match) return parseInt(match[1]);
    return 0;
}

function extractCoupon(text, basePrice) {
    let discount = 0;
    text = text.toLowerCase();
    let matches = [...text.matchAll(/₹\s?(\d{1,5})/g)];
    if (matches.length > 0) discount += Math.max(...matches.map(m => parseInt(m[1])));
    let percentMatch = text.match(/(\d{1,3})\s?%/);
    if (percentMatch && basePrice > 0) discount += Math.floor((parseInt(percentMatch[1]) / 100) * basePrice);
    return discount;
}

/* ================= OCR ENGINE & BROWSER SCRAPER ================= */

async function getPriceViaOCR(url, msgId) {
    let browser = null;
    let asin = null;

    try {
        let finalUrl = await resolveUrl(url);
        const asinMatch = finalUrl.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
        if (asinMatch && asinMatch[1]) {
            asin = asinMatch[1];
            finalUrl = `https://www.amazon.in/dp/${asin}`;
        }

        console.log(`🌐 Launching Headless Browser for: ${finalUrl}`);

        browser = await puppeteer.launch({
            args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
            defaultViewport: { width: 412, height: 915, isMobile: true }, // Mobile Viewport
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1');
        
        await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 20000 });

        // Screenshot page top section where price is visible
        const screenshotBuffer = await page.screenshot({ fullPage: false, type: 'png' });
        await browser.close();
        browser = null;

        console.log(`🔍 Running Tesseract OCR on page screenshot...`);

        // OCR Processing
        const { data: { text } } = await Tesseract.recognize(screenshotBuffer, 'eng', {
            logger: m => {} 
        });

        console.log(`📝 OCR Extracted Raw Text:\n${text.substring(0, 200)}...`);

        // Stock check via OCR Text
        const lowerText = text.toLowerCase();
        if (lowerText.includes("currently unavailable") || lowerText.includes("out of stock") || lowerText.includes("sold out")) {
            console.log(`🔴 Status via OCR: Out of Stock (9999999)`);
            return 9999999;
        }

        // Regex parsing on OCR text
        const priceMatches = [...text.matchAll(/(?:₹|INR|\$)\s?([\d,]{2,7})/gi)];
        let detectedPrices = priceMatches.map(m => parseInt(m[1].replace(/,/g, ''))).filter(p => p > 10 && p < 1000000);

        if (detectedPrices.length > 0) {
            const finalPrice = Math.min(...detectedPrices);
            console.log(`✅ Price extracted via OCR: ₹${finalPrice}`);
            return finalPrice;
        }

        console.log(`❌ OCR failed to find valid price pattern.`);
        await sendDebugPayload(screenshotBuffer, asin, msgId, finalUrl);
        return null;

    } catch (err) {
        console.log(`⚠️ Browser/OCR Engine Error: ${err.message}`);
        if (browser) await browser.close();
        return null;
    }
}

/* ================= QUEUE MANAGER ================= */

function processQueue() {
    if (queue.length === 0 || activeWorkers >= MAX_CONCURRENT_TASKS) return;

    activeWorkers++;
    const task = queue.shift();

    monitorTask(task).finally(() => {
        activeWorkers--;
        processQueue();
    });
}

async function monitorTask(task) {
    const { url, msgId, chatId, text, oldPrice, coupon, isMedia, timestamp } = task;

    console.log(`\n-----------------------------------------`);
    console.log(`🔄 Processing Task | Msg ID: ${msgId} | Old Price: ₹${oldPrice}`);

    if (Date.now() - timestamp > 3 * 60 * 60 * 1000) {
        db.remove({ msgId }, {});
        return;
    }

    const price = await getPriceViaOCR(url, msgId);
    console.log(`📊 Result [Msg ID: ${msgId}]: Price = ${price}`);

    if (price && typeof price === "number" && price > 10) {
        let finalPrice = price - (coupon > 0 && coupon < price ? coupon : 0);
        const dbTask = await new Promise(res => db.findOne({ msgId }, (e, d) => res(d)));

        if (oldPrice > 0 && finalPrice >= oldPrice * 1.2 && dbTask?.status !== "over") {
            const updatedText = `${text}\n\n❌❌Price Over Now❌❌\n\nIf you got Send Screenshot me @Ldt_admin_bot`;
            try {
                if (isMedia) {
                    await bot.telegram.editMessageCaption(chatId, msgId, undefined, updatedText);
                } else {
                    await bot.telegram.editMessageText(chatId, msgId, undefined, updatedText);
                }
            } catch (err) {}
            db.update({ msgId }, { $set: { status: "over" } });
        }
    }

    setTimeout(() => {
        queue.push(task);
        processQueue();
    }, 3 * 60 * 1000);
}

/* ================= BOT LISTENER ================= */

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || ctx.channelPost.caption || "";
    const urls = text.match(/https?:\/\/[^\s]+/g);

    if (!urls || urls.length !== 1) return;

    const url = urls[0];
    const msgId = ctx.channelPost.message_id;

    if (/^https?:\/\/(www\.)?(flipkart\.com|amazon\.in|myntra\.com)\/?$/i.test(url)) return;

    const basePrice = extractPostPrice(text);
    const coupon = extractCoupon(text, basePrice);
    let oldPrice = (coupon > 0 && basePrice > coupon) ? basePrice - coupon : basePrice;

    const taskData = {
        url,
        msgId,
        chatId: ctx.chat.id,
        text,
        oldPrice,
        coupon,
        isMedia: !!(ctx.channelPost.photo || ctx.channelPost.video || ctx.channelPost.document),
        timestamp: Date.now()
    };

    db.insert({ msgId, status: "running", timestamp: taskData.timestamp });
    queue.push(taskData);
    processQueue();
});
