const { Telegraf } = require('telegraf');
const axios = require('axios');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

/* ================= DB ================= */
const db = new Datastore({ filename: 'tasks.db', autoload: true });

/* ================= BOT ================= */
const bot = new Telegraf(process.env.BOT_TOKEN);

/* ================= SERVER ================= */
const app = express();
app.get('/', (req, res) => res.send("OK"));
app.listen(process.env.PORT || 7860, '0.0.0.0');

/* ================= GLOBAL ================= */
let browser = null;
let queue = [];
let isProcessing = false;

/* ================= BOT START ================= */
bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log("🚀 Bot is live!");
    // 🧹 3 घंटे से पुराने टास्क स्टार्टअप पर ही डिलीट करें
    const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
    db.remove({ timestamp: { $lt: threeHoursAgo } }, { multi: true }, (err, numRemoved) => {
        console.log(`🧹 Cleaned up ${numRemoved} old tasks from DB.`);
    });
});


/* ================= UTILS ================= */

        async function resolveUrl(url) {
    let page;
    try {
        console.log("🔍 Browser Unshorting Start:", url);
        const br = await getBrowser();
        page = await br.newPage();

        // ⚡ User-Agent सेट करें ताकि Amazon ब्लॉक न करे
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.goto(url, { 
            waitUntil: 'networkidle2', // इसे बदलें
            timeout: 30000 
        });

        // Amazon के रीडायरेक्ट के लिए थोड़ा इंतज़ार करें
        await new Promise(r => setTimeout(r, 7000)); 

        const finalUrl = page.url();
        console.log("✅ Final URL found:", finalUrl);
        return finalUrl;

    } catch (e) {
        console.log("⚠️ Browser Unshort Failed:", e.message);
        return url;
    } finally {
        if (page) await page.close();
    }
}

// 🛒 AMAZON
function extractAmazon(html) {
    let match = html.match(/a-price-whole">([\d,]+)/);
    return match ? parseInt(match[1].replace(/,/g,'')) : null;
}

// 🛒 FLIPKART
function extractFlipkart(html) {
    let match =
        html.match(/_30jeq3[^>]*>([\d,]+)/) ||
        html.match(/_16Jk6d[^>]*>([\d,]+)/) ||
        html.match(/₹\s?([\d,]+)/);

    return match ? parseInt(match[1].replace(/,/g,'')) : null;
}

// 🛒 MYNTRA
function extractMyntra(html) {
    let match = html.match(/"price":\s?(\d+)/);
    return match ? parseInt(match[1]) : null;
}

// 🧠 POST PRICE
function extractPostPrice(text) {

    let matches = [...text.matchAll(/₹\s?(\d{2,6})/g)];

    if (matches.length > 0) {
        let prices = matches.map(m => parseInt(m[1]));
        return Math.min(...prices);
    }

    let match = text.match(/(\d{2,6})\s?\/-/);
    if (match) return parseInt(match[1]);

    const firstLine = text.split('\n')[0];
    match = firstLine.match(/(\d{2,6})/);
    if (match) return parseInt(match[1]);

    return 0;
}

// 🧠 COUPON + DISCOUNT
function extractCoupon(text, basePrice) {

    let discount = 0;

    text = text.toLowerCase();

    // ₹ values detect
    let matches = [...text.matchAll(/₹\s?(\d{1,5})/g)];
    if (matches.length > 0) {
        let values = matches.map(m => parseInt(m[1]));
        discount += Math.max(...values);
    }

    // % discount
    let percentMatch = text.match(/(\d{1,3})\s?%/);
    if (percentMatch && basePrice > 0) {
        let percent = parseInt(percentMatch[1]);
        discount += Math.floor((percent / 100) * basePrice);
    }

    // bank/card
    let bankMatches = [...text.matchAll(/₹\s?(\d{1,5}).*(bank|card|credit|debit)/g)];
    for (let m of bankMatches) {
        discount += parseInt(m[1]);
    }

    return discount;
}

/* ================= FAST SCRAPE ================= */

async function fastScrape(url) {
    try {
        const finalUrl = url;

        const { data } = await axios.get(finalUrl, {
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml",
        "Connection": "keep-alive"
    },
    timeout: 15000
});

        if (/amazon\./i.test(finalUrl)) return extractAmazon(data);
        if (/flipkart\./i.test(finalUrl)) return extractFlipkart(data);
        if (/myntra\./i.test(finalUrl)) return extractMyntra(data);

        return null;

    } catch {
        return null;
    }
}

/* ================= PUPPETEER ================= */

async function getBrowser() {
    if (!browser || !browser.connected) { // अगर ब्राउज़र बंद हो गया हो तो नया खोलें
        browser = await puppeteer.launch({
            headless: "new",
            executablePath: '/usr/bin/chromium',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', // परफॉरमेंस के लिए
                '--no-first-run',
                '--no-zygote',
                '--single-process', // RAM बचाने के लिए
                '--disable-gpu'
            ]
        });
    
    process.setMaxListeners(0); 
    }
    return browser;
}


async function fallbackScrape(url) {
    try {
        const br = await getBrowser();
        const page = await br.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)'
        );

        await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
});

// 🔥 extra wait for Flipkart JS
await new Promise(r => setTimeout(r, 4000));

// 🔥 scroll multiple times
for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await new Promise(r => setTimeout(r, 1000));
}
        await page.waitForSelector('body', { timeout: 5000 }).catch(() => {});

// 🔥 Flipkart popup close (IMPORTANT)
try {
    await page.click('button._2KpZ6l._2doB4z', { timeout: 3000 });
} catch {}

        const result = await page.evaluate(() => {

    const bodyText = document.body.innerText.toLowerCase();

    if (
        bodyText.includes("currently unavailable") ||
        bodyText.includes("out of stock") ||
        bodyText.includes("sold out")
    ) {
        return "OUT";
    }

    // 🟢 ADD THIS BLOCK (Myntra fix)
    const script = document.querySelector('script[type="application/ld+json"]');

    if (script) {
        try {
            const json = JSON.parse(script.innerText);

            if (json && json.offers && json.offers.price) {
                return parseInt(json.offers.price);
            }

        } catch {}
    }

    // 🔍 selectors
    const selectors = [
     // 🔥 Amazon (New & Old)
        '.a-price-whole',
        '.a-price .a-offscreen',
        '#priceblock_ourprice',
        '#priceblock_dealprice',
        'span.a-color-price',
        'span.a-price-whole',
        '#corePrice_feature_div .a-price-whole',
        '#twister-plus-price-data-price',
         

    // Flipkart core
    '._30jeq3',
    '._16Jk6d',
    '._25b18c',
    '.Nx9bqj.C93Y7v',

    // Flipkart dynamic
    '[class*="Nx9bqj"]',
    '[class*="CEmiEU"]',
    '[class*="hl05eU"]',   // 🔥 ADD
    '._1_WHN1',    // 🔥 ADD
     '[data-testid="price"]',
      '[class*="priceView"]',

     // Mobile main price
        '.Nx9bqj',        // Desktop main price
        '._30jeq3._16Jk6d',
       
        
    // generic fallback
    '[class*="_30jeq3"]',
    '[class*="price"]',

    // Myntra के लिए ये नया सेलेक्टर जोड़ें
    '.pdp-discount-summary .pdp-price strong', 
    '.pdp-mrp',
    '.pdp-price'

];

    for (let s of selectors) {
        const el = document.querySelector(s);
        // हमने यहाँ el.innerText.trim() चेक किया है ताकि खाली डेटा न मिले
        if (el && el.innerText.trim().length > 0) {
            let p = parseInt(el.innerText.replace(/[^\d]/g, ''));
            if (p > 10) return p;
        }
    }
  // 🔥 FINAL TEXT FALLBACK (Flipkart killer fix)
let match = document.body.innerText.match(/₹\s?(\d{2,6})/);
if (match) return parseInt(match[1]);
    return null;
});
        await page.close();

        if (result === "OUT") return 9999999;

        return result;

    } catch {
    return null;
}
}

/* ================= MAIN ================= */

async function getPrice(url) {

    console.log("🔗 URL:", url);

    const finalUrl = await resolveUrl(url);

let price = await fastScrape(finalUrl);

    // ✅ fast success
    if (typeof price === "number" && price > 10) {
        console.log("⚡ Fast success:", price);
        return price;
    }

    console.log("🐢 Using browser...");
    price = await fallbackScrape(finalUrl);

    // ✅ fallback success
    if (typeof price === "number" && price > 10) {
        console.log("🐢 Fallback success:", price);
        return price;
    }

    console.log("❌ Price not found");
    return null;
}
async function processQueue() {
    if (queue.length === 0) return;

    // क्यू से टास्क निकालें
    const task = queue.shift();
    
    // टास्क को बिना 'await' किए बैकग्राउंड में चला दें (ताकि अगला टास्क तुरंत शुरू हो सके)
    monitorTask(task).catch(e => console.error("❌ Monitor Error:", e));

    // अगर और भी टास्क हैं, तो तुरंत फिर से प्रोसेस करें
    if (queue.length > 0) {
        setImmediate(processQueue);
    }
}

async function monitorTask(task) {
    const { url, msgId, chatId, text, oldPrice, coupon, isMedia } = task;
    let startTime = Date.now();

    while (Date.now() - startTime < 3 * 60 * 60 * 1000) { // 3 घंटे तक मॉनिटरिंग
        const price = await getPrice(url);
        console.log("🔍 Price check:", url, price);

        if (!price || typeof price !== "number" || price < 10) {
            await new Promise(r => setTimeout(r, 300000)); // 1 min wait if error
            continue;
        }

        let finalPrice = price - (coupon > 0 && coupon < price ? coupon : 0);

        const dbTask = await new Promise(res =>
            db.findOne({ msgId }, (e, d) => res(d))
        );

        // 🔥 1. PRICE OVER LOGIC
        if (oldPrice > 0 && finalPrice >= oldPrice * 1.2 && dbTask?.status !== "over") {
            const updatedText = `${text}\n\n❌❌Price Over Now❌❌\n\nIf you got Send Screenshot me @Ldt_admin_bot`;
            try {
                if (isMedia) {
                    await bot.telegram.editMessageCaption(chatId, msgId, undefined, updatedText);
                } else {
                    await bot.telegram.editMessageText(chatId, msgId, undefined, updatedText);
                }
            } catch (err) { console.log("⚠️ Edit Error:", err.description); }
            db.update({ msgId }, { $set: { status: "over" } });
        }

        // 🟢 2. BACK IN STOCK LOGIC
        if (dbTask && dbTask.status === "over" && finalPrice <= oldPrice) {
            const replyText = `🟢━━━━━━━━━━━━━━🟢\n🔥 BACK IN STOCK 🔥\n🟢━━━━━━━━━━━━━━🟢\n\n💰 Current Price: ₹${finalPrice}\n⚡ Deal is LIVE again!\n👉 Grab fast before it's gone`;
            try {
                await bot.telegram.sendMessage(chatId, replyText, {
                    reply_to_message_id: msgId
                });
                console.log(`✅ Reply sent: ${msgId}`);
            } catch (err) { console.log("⚠️ Reply Error:", err.description); }
            db.update({ msgId }, { $set: { status: "active" } });
        }

        // ⏱️ हर चेक के बाद 3 मिनट का इंतज़ार (जरूरी है)
        await new Promise(r => setTimeout(r, 300000)); 

    } // <--- 'while' लूप यहाँ बंद होगा

    console.log("🧹 Task duration over for:", msgId);
    db.remove({ msgId }, {}); 
} 

/* ================= BOT ================= */

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || ctx.channelPost.caption || "";
    const urls = text.match(/https?:\/\/[^\s]+/g);

    // ❌ No link OR multiple links → skip
    if (!urls || urls.length !== 1) {
        console.log("⛔ Skipped: No link or multiple links");
        return;
    }

    const url = urls[0];
    const msgId = ctx.channelPost.message_id;
    const postDate = ctx.channelPost.date * 1000;

    // ❌ अगर पोस्ट 3 घंटे से ज़्यादा पुरानी है
    if (Date.now() - postDate > 3 * 60 * 60 * 1000) {
        console.log(`⛔ Skipped: Too old post (${msgId})`);
        return;
    }

    // ❌ MASTER LINK check
    if (/^https?:\/\/(www\.)?(flipkart\.com|amazon\.in|myntra\.com)\/?$/i.test(url)) {
        console.log("⛔ Skipped: Master link");
        return;
    }

    // --- यहाँ से सुधार शुरू ---

    // 1. पहले चेक करें कि क्या यह पहले से चल रहा है (DB और Queue दोनों में)
    const checkTask = await new Promise(res => db.findOne({ msgId, status: "running" }, (e, d) => res(d)));
    const inQueue = queue.find(q => q.msgId === msgId);

    if (checkTask || inQueue) {
        console.log("⛔ Skipped: Task already running or in queue for", msgId);
        return;
    }

    const basePrice = extractPostPrice(text);
    const coupon = extractCoupon(text, basePrice);

    let oldPrice = basePrice;
    if (coupon > 0 && basePrice > coupon) {
        oldPrice = basePrice - coupon;
    }

    const isMedia = !!(ctx.channelPost.photo || ctx.channelPost.video || ctx.channelPost.document);

    // 2. अब इसे "running" मार्क करें और क्यू में डालें
    db.update({ msgId }, { $set: { msgId, url, status: "running", timestamp: Date.now() } }, { upsert: true });

    queue.push({
        url,
        msgId,
        chatId: ctx.chat.id,
        text,
        oldPrice,
        coupon,
        isMedia
    });

    processQueue();
});
