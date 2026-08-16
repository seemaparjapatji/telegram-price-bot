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
const MAX_CONCURRENT_TASKS = 3;

// Mobile User Agents work best against Cloud Render IP Blocks
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
    console.log("🚀 Enhanced Price Monitor Bot is live!");
    cleanupOldTasks();
}).catch(err => console.error("❌ Launch Error:", err.message));

setInterval(cleanupOldTasks, 60 * 60 * 1000);

function cleanupOldTasks() {
    const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
    db.remove({ timestamp: { $lt: threeHoursAgo } }, { multi: true }, (err, numRemoved) => {
        if (numRemoved) console.log(`🧹 Cleaned up ${numRemoved} old tasks from DB.`);
    });
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
    if (matches.length > 0) {
        return Math.min(...matches.map(m => parseInt(m[1])));
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

/* ================= SCRAPING LOGIC ================= */

async function getPrice(url) {
    try {
        let finalUrl = await resolveUrl(url);

        // Amazon Clean ASIN Link Optimization
        if (/amazon\./i.test(finalUrl)) {
            const asinMatch = finalUrl.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
            if (asinMatch && asinMatch[1]) {
                finalUrl = `https://www.amazon.in/dp/${asinMatch[1]}`;
                console.log(`🎯 Amazon Clean Mobile URL: ${finalUrl}`);
            }
        }

        console.log(`📥 Fetching HTML for: ${finalUrl}`);
        const { data: html } = await axios.get(finalUrl, {
            headers: {
                'User-Agent': getRandomUA(),
                'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none'
            },
            timeout: 12000
        });

        const $ = cheerio.load(html);
        const lowerHtml = html.toLowerCase();

        // Stock Check
        if (lowerHtml.includes("currently unavailable") || lowerHtml.includes("out of stock") || lowerHtml.includes("sold out")) {
            console.log(`🔴 Status: Out of Stock (Marked 9999999)`);
            return 9999999;
        }

        // 1. JSON-LD Parsing (High Precision)
        const jsonLdScripts = $('script[type="application/ld+json"]');
        for (let i = 0; i < jsonLdScripts.length; i++) {
            try {
                const json = JSON.parse($(jsonLdScripts[i]).html());
                if (json) {
                    let offers = json.offers || (json[0] && json[0].offers);
                    if (offers) {
                        let price = Array.isArray(offers) ? offers[0]?.price : offers?.price;
                        if (price) {
                            console.log(`✅ Price via JSON-LD: ₹${price}`);
                            return parseInt(price);
                        }
                    }
                }
            } catch (e) {}
        }

        // 2. Amazon Specific Robust Selectors
        if (/amazon\./i.test(finalUrl)) {
            // Offscreen Text
            const offscreenText = $('.a-price .a-offscreen, #corePrice_feature_div .a-offscreen, #apex_desktop .a-offscreen, .priceBlockBuyingPriceString').first().text().trim();
            if (offscreenText) {
                let p = parseInt(offscreenText.replace(/,/g, '').replace(/[^\d]/g, ''));
                if (p > 10) {
                    console.log(`✅ Price via Amazon Offscreen: ₹${p}`);
                    return p;
                }
            }

            // Whole Price Span
            const wholePriceText = $('.a-price-whole').first().text().trim();
            if (wholePriceText) {
                let p = parseInt(wholePriceText.replace(/,/g, '').replace(/[^\d]/g, ''));
                if (p > 10) {
                    console.log(`✅ Price via Amazon Whole Price: ₹${p}`);
                    return p;
                }
            }
        }

        // 3. Flipkart Specific Selectors
        if (/flipkart\.com/i.test(finalUrl)) {
            const fkSelectors = ['._30jeq3', '._16Jk6d', '.Nx9bqj', '[class*="Nx9bqj"]'];
            for (let s of fkSelectors) {
                let txt = $(s).first().text().trim();
                if (txt) {
                    let p = parseInt(txt.replace(/[^\d]/g, ''));
                    if (p > 10) {
                        console.log(`✅ Price via Flipkart Selector (${s}): ₹${p}`);
                        return p;
                    }
                }
            }
        }

        // 4. Emergency Regular Expression Regex Fallback (HTML raw text parse)
        const priceMatch = html.match(/class="a-price-whole"[^>]*>\s*([\d,]+)/i) || 
                           html.match(/"priceAmount":\s*([\d.]+)/i) || 
                           html.match(/["']price["']\s*:\s*["']?([\d,]+)/i);

        if (priceMatch && priceMatch[1]) {
            let p = parseInt(priceMatch[1].replace(/,/g, ''));
            if (p > 10) {
                console.log(`✅ Price via Regex Emergency Fallback: ₹${p}`);
                return p;
            }
        }

        console.log(`❌ Price Selectors Matched Nothing.`);
        return null;

    } catch (error) {
        console.log(`⚠️ Scrape Error [Status: ${error.response?.status || error.code || 'ERR'}]: ${error.message}`);
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
        console.log(`⏰ Task expired (> 3 hours). Removing Msg ID: ${msgId}`);
        db.remove({ msgId }, {});
        return;
    }

    const price = await getPrice(url);
    console.log(`📊 Result [Msg ID: ${msgId}]: Price = ${price}`);

    if (price && typeof price === "number" && price > 10) {
        let finalPrice = price - (coupon > 0 && coupon < price ? coupon : 0);
        const dbTask = await new Promise(res => db.findOne({ msgId }, (e, d) => res(d)));

        // PRICE OVER LOGIC
        if (oldPrice > 0 && finalPrice >= oldPrice * 1.2 && dbTask?.status !== "over") {
            console.log(`🚨 Triggering PRICE OVER for Msg ID: ${msgId} (Old: ${oldPrice}, New: ${finalPrice})`);
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
            console.log(`🟢 Triggering BACK IN STOCK for Msg ID: ${msgId}`);
            const replyText = `🟢━━━━━━━━━━━━━━🟢\n🔥 BACK IN STOCK 🔥\n🟢━━━━━━━━━━━━━━🟢\n\n💰 Current Price: ₹${finalPrice}\n⚡ Deal is LIVE again!\n👉 Grab fast before it's gone`;
            try {
                await bot.telegram.sendMessage(chatId, replyText, { reply_to_message_id: msgId });
            } catch (err) { console.log("⚠️ Reply Error:", err.description); }
            db.update({ msgId }, { $set: { status: "active" } });
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
    const postDate = ctx.channelPost.date * 1000;

    console.log(`📌 New Channel Post Detected | Msg ID: ${msgId}`);

    if (Date.now() - postDate > 3 * 60 * 60 * 1000) {
        console.log(`⏩ Skipping post older than 3 hours.`);
        return;
    }

    if (/^https?:\/\/(www\.)?(flipkart\.com|amazon\.in|myntra\.com)\/?$/i.test(url)) {
        console.log(`⏩ Skipping home page URL.`);
        return;
    }

    const checkTask = await new Promise(res => db.findOne({ msgId }, (e, d) => res(d)));
    if (checkTask) {
        console.log(`⏩ Task already present in DB.`);
        return;
    }

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

    console.log(`➕ Added Task to Queue | Msg ID: ${msgId} | Detected Price: ₹${oldPrice}`);

    db.insert({ msgId, status: "running", timestamp: taskData.timestamp });
    queue.push(taskData);
    processQueue();
});
