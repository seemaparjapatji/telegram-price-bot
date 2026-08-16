const { Telegraf } = require('telegraf');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const Datastore = require('@seald-io/nedb');

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
const MAX_CONCURRENT_TASKS = 5; // Browser na hone se ab hum 5 parallel tasks aaram se chala sakte hain

/* ================= BOT START ================= */
bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log("🚀 Pure HTTP Bot is live!");
    cleanupOldTasks();
});

setInterval(cleanupOldTasks, 60 * 60 * 1000);

function cleanupOldTasks() {
    const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
    db.remove({ timestamp: { $lt: threeHoursAgo } }, { multi: true }, (err, numRemoved) => {
        console.log(`🧹 Cleaned up ${numRemoved} old tasks from DB.`);
    });
}

/* ================= UTILS & PARSERS ================= */

// Pure HTTP Redirect Unshortener
async function resolveUrl(url) {
    try {
        const response = await axios.get(url, {
            maxRedirects: 10,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 10000
        });
        return response.request.res.responseUrl || url;
    } catch (e) {
        if (e.response && e.response.request && e.response.request.res) {
            return e.response.request.res.responseUrl;
        }
        return url;
    }
}

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

function extractCoupon(text, basePrice) {
    let discount = 0;
    text = text.toLowerCase();

    let matches = [...text.matchAll(/₹\s?(\d{1,5})/g)];
    if (matches.length > 0) {
        discount += Math.max(...matches.map(m => parseInt(m[1])));
    }

    let percentMatch = text.match(/(\d{1,3})\s?%/);
    if (percentMatch && basePrice > 0) {
        discount += Math.floor((parseInt(percentMatch[1]) / 100) * basePrice);
    }

    return discount;
}

/* ================= DATA SCRAPE & PRICE EXTRACT ================= */

async function getPrice(url) {
    try {
        const finalUrl = await resolveUrl(url);

        // 1. Scrape HTML Data via Axios
        const { data: html } = await axios.get(finalUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Cache-Control': 'no-cache'
            },
            timeout: 12000
        });

        const $ = cheerio.load(html);
        const lowerHtml = html.toLowerCase();

        // Stock Status Check
        if (lowerHtml.includes("currently unavailable") || lowerHtml.includes("out of stock") || lowerHtml.includes("sold out")) {
            return 9999999; // Out of stock
        }

        // 2. JSON-LD Schema Extract (Myntra / General E-commerce Fix)
        const jsonLdScripts = $('script[type="application/ld+json"]');
        for (let i = 0; i < jsonLdScripts.length; i++) {
            try {
                const json = JSON.parse($(jsonLdScripts[i]).html());
                if (json && json.offers) {
                    const price = Array.isArray(json.offers) ? json.offers[0]?.price : json.offers?.price;
                    if (price) return parseInt(price);
                }
            } catch (e) {}
        }

        // 3. Site-Specific Selector Checks
        const selectors = [
            // Amazon
            '.a-price-whole', '.a-price .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice',
            // Flipkart
            '._30jeq3', '._16Jk6d', '.Nx9bqj', '[class*="Nx9bqj"]', '._30jeq3._16JJk6d',
            // Myntra / Ajio
            '.pdp-discount-summary .pdp-price strong', '.pdp-price', '.prod-sp'
        ];

        for (let selector of selectors) {
            const elementText = $(selector).first().text().trim();
            if (elementText) {
                let parsedPrice = parseInt(elementText.replace(/[^\d]/g, ''));
                if (parsedPrice > 10) return parsedPrice;
            }
        }

        // 4. Fallback Regex directly on HTML Body
        let bodyText = $('body').text();
        let match = bodyText.match(/₹\s?([\d,]{2,7})/);
        if (match) {
            let parsedPrice = parseInt(match[1].replace(/,/g, ''));
            if (parsedPrice > 10) return parsedPrice;
        }

        return null;

    } catch (error) {
        console.log("⚠️ Scrape Error:", error.message);
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

    if (Date.now() - timestamp > 3 * 60 * 60 * 1000) {
        db.remove({ msgId }, {});
        return;
    }

    const price = await getPrice(url);
    console.log(`🔍 Checked [Msg: ${msgId}]:`, price);

    if (price && typeof price === "number" && price > 10) {
        let finalPrice = price - (coupon > 0 && coupon < price ? coupon : 0);
        const dbTask = await new Promise(res => db.findOne({ msgId }, (e, d) => res(d)));

        // PRICE OVER LOGIC
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

        // BACK IN STOCK LOGIC
        if (dbTask && dbTask.status === "over" && finalPrice <= oldPrice) {
            const replyText = `🟢━━━━━━━━━━━━━━🟢\n🔥 BACK IN STOCK 🔥\n🟢━━━━━━━━━━━━━━🟢\n\n💰 Current Price: ₹${finalPrice}\n⚡ Deal is LIVE again!\n👉 Grab fast before it's gone`;
            try {
                await bot.telegram.sendMessage(chatId, replyText, { reply_to_message_id: msgId });
            } catch (err) { console.log("⚠️ Reply Error:", err.description); }
            db.update({ msgId }, { $set: { status: "active" } });
        }
    }

    // Re-queue task every 3 minutes
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
    const postDate = ctx.channelPost.date * 1000;

    if (Date.now() - postDate > 3 * 60 * 60 * 1000) return;
    if (/^https?:\/\/(www\.)?(flipkart\.com|amazon\.in|myntra\.com)\/?$/i.test(url)) return;

    const checkTask = await new Promise(res => db.findOne({ msgId }, (e, d) => res(d)));
    if (checkTask) return;

    const basePrice = extractPostPrice(text);
    const coupon = extractCoupon(text, basePrice);
    let oldPrice = (coupon > 0 && basePrice > coupon) ? basePrice - coupon : basePrice;

    const isMedia = !!(ctx.channelPost.photo || ctx.channelPost.video || ctx.channelPost.document);

    const taskData = {
        url,
        msgId,
        chatId: ctx.chat.id,
        text,
        oldPrice,
        coupon,
        isMedia,
        timestamp: Date.now()
    };

    db.insert({ msgId, status: "running", timestamp: taskData.timestamp });
    queue.push(taskData);
    processQueue();
});
