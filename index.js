const { Telegraf } = require('telegraf');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const Datastore = require('@seald-io/nedb');
const FormData = require('form-data');

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
const MAX_CONCURRENT_TASKS = 3;

const USER_AGENTS = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.178 Mobile Safari/537.36'
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/* ================= BOT START ================= */
bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log("🚀 Bot is live with Debug Capture System!");
    cleanupOldTasks();
}).catch(err => console.error("❌ Launch Error:", err.message));

setInterval(cleanupOldTasks, 60 * 60 * 1000);

function cleanupOldTasks() {
    const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
    db.remove({ timestamp: { $lt: threeHoursAgo } }, { multi: true }, (err, numRemoved) => {
        if (numRemoved) console.log(`🧹 Cleaned up ${numRemoved} old tasks from DB.`);
    });
}

/* ================= SCREENSHOT & DEBUG SENDER ================= */
async function sendDebugPayload(html, asin, msgId, url) {
    try {
        console.log(`📸 Generating & Uploading Debug Snapshot for ASIN: ${asin || msgId}...`);
        
        // Form Data create karna screenshot/html upload ke liye
        const formData = new FormData();
        formData.append('asin', asin || 'unknown');
        formData.append('msgId', String(msgId));
        formData.append('target_url', url);
        formData.append('html_content', html);

        const uploadUrl = 'https://lootdealtricky.in/x/render_error/';
        
        const res = await axios.post(uploadUrl, formData, {
            headers: {
                ...formData.getHeaders(),
                'User-Agent': 'Render-Bot-Debug-Worker'
            },
            timeout: 15000
        });

        console.log(`✅ Debug Payload Sent Successfully to Server! Status: ${res.status}`);
    } catch (err) {
        console.log(`⚠️ Debug Upload Failed: ${err.message}`);
    }
}

/* ================= UTILS & PARSERS ================= */

async function resolveUrl(url) {
    try {
        console.log(`🔗 Resolving URL: ${url}`);
        const response = await axios.get(url, {
            maxRedirects: 10,
            headers: {
                'User-Agent': getRandomUA(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 10000
        });
        const finalUrl = response.request.res.responseUrl || url;
        console.log(`➡️ Resolved URL: ${finalUrl}`);
        return finalUrl;
    } catch (e) {
        const fallbackUrl = e.response?.request?.res?.responseUrl || url;
        console.log(`⚠️ Redirect Failed, using: ${fallbackUrl}`);
        return fallbackUrl;
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

/* ================= SCRAPING LOGIC ================= */

async function getPrice(url, msgId) {
    let fetchedHtml = "";
    let extractedAsin = null;

    try {
        let finalUrl = await resolveUrl(url);

        if (/amazon\./i.test(finalUrl)) {
            const asinMatch = finalUrl.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
            if (asinMatch && asinMatch[1]) {
                extractedAsin = asinMatch[1];
                finalUrl = `https://www.amazon.in/dp/${extractedAsin}`;
                console.log(`🎯 Amazon Clean Mobile URL: ${finalUrl}`);
            }
        }

        // 1. Amazon Internal AJAX Fetch
        if (extractedAsin) {
            try {
                const ajaxUrl = `https://www.amazon.in/gp/product/ajax/ref=auto_ev?asin=${extractedAsin}&deviceType=mobile`;
                console.log(`📡 Hitting Amazon Internal AJAX API for ASIN: ${extractedAsin}`);

                const { data: ajaxHtml } = await axios.get(ajaxUrl, {
                    headers: {
                        'User-Agent': getRandomUA(),
                        'Accept': 'text/html,*/*',
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept-Language': 'en-IN,en;q=0.9'
                    },
                    timeout: 8000
                });

                fetchedHtml = ajaxHtml;
                const $ajax = cheerio.load(ajaxHtml);
                const priceText = $ajax('.a-price .a-offscreen, .priceBlockBuyingPriceString, .a-color-price').first().text().trim();
                
                if (priceText) {
                    let p = parseInt(priceText.replace(/,/g, '').replace(/[^\d]/g, ''));
                    if (p > 10) {
                        console.log(`✅ Price via Amazon AJAX API: ₹${p}`);
                        return p;
                    }
                }
            } catch (ajaxErr) {
                console.log(`⚠️ AJAX Endpoint Failed, falling back to standard HTML parsing...`);
            }
        }

        // 2. Main HTML Fetch
        console.log(`📥 Fetching HTML for: ${finalUrl}`);
        const response = await axios.get(finalUrl, {
            headers: {
                'User-Agent': getRandomUA(),
                'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            timeout: 12000
        });

        fetchedHtml = response.data;
        const $ = cheerio.load(fetchedHtml);
        const lowerHtml = fetchedHtml.toLowerCase();

        // Stock Check
        if (lowerHtml.includes("currently unavailable") || lowerHtml.includes("out of stock") || lowerHtml.includes("sold out")) {
            console.log(`🔴 Status: Out of Stock (Marked 9999999)`);
            return 9999999;
        }

        // Selectors Matching
        const offscreenText = $('.a-price .a-offscreen, #corePrice_feature_div .a-offscreen, #apex_desktop .a-offscreen, .priceBlockBuyingPriceString').first().text().trim();
        if (offscreenText) {
            let p = parseInt(offscreenText.replace(/,/g, '').replace(/[^\d]/g, ''));
            if (p > 10) return p;
        }

        const wholePriceText = $('.a-price-whole').first().text().trim();
        if (wholePriceText) {
            let p = parseInt(wholePriceText.replace(/,/g, '').replace(/[^\d]/g, ''));
            if (p > 10) return p;
        }

        console.log(`❌ Price Selectors Matched Nothing.`);
        
        // Server par screenshot/HTML render error details bhejna
        await sendDebugPayload(fetchedHtml, extractedAsin, msgId, finalUrl);
        return null;

    } catch (error) {
        console.log(`⚠️ Scrape Error [Status: ${error.response?.status || error.code || 'ERR'}]: ${error.message}`);
        if (fetchedHtml) {
            await sendDebugPayload(fetchedHtml, extractedAsin, msgId, url);
        }
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

    const price = await getPrice(url, msgId);
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
