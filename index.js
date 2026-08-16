require('dotenv').config();
const { Bot } = require('grammy');
const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');

// Render free tier ko active rakhne ke liye chota HTTP server
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
}).listen(process.env.PORT || 3000);

const bot = new Bot(process.env.BOT_TOKEN);

// User agent taaki website block na kare
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
};

bot.command('start', (ctx) => {
    ctx.reply('👋 Send me an Amazon, Flipkart, or Ajio link to get the price!');
});

bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;

    if (!text.startsWith('http')) {
        return ctx.reply('⚠️ Please send a valid link starting with http or https.');
    }

    const statusMsg = await ctx.reply('🔍 Fetching price...');

    try {
        const response = await axios.get(text, { headers: HEADERS, timeout: 8000 });
        const $ = cheerio.load(response.data);
        let price = null;
        let title = $('title').text().trim().substring(0, 60) + '...';

        // 1. Amazon
        if (text.includes('amazon')) {
            price = $('.a-price-whole').first().text().replace(/[^0-9]/g, '') ||
                    $('.a-offscreen').first().text();
        } 
        // 2. Flipkart
        else if (text.includes('flipkart')) {
            price = $('._30jeq3._16JThd').first().text() || 
                    $('._30jeq3').first().text();
        } 
        // 3. Ajio
        else if (text.includes('ajio')) {
            price = $('.prod-sp').first().text();
        } 
        // 4. Generic Websites
        else {
            price = $('meta[property="product:price:amount"]').attr('content') ||
                    $('meta[property="og:price:amount"]').attr('content');
        }

        if (price) {
            await ctx.api.editMessageText(
                ctx.chat.id, 
                statusMsg.message_id, 
                `📦 **Product:** ${title}\n💰 **Price:** ₹${price.toString().trim()}`,
                { parse_mode: 'Markdown' }
            );
        } else {
            await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '❌ Price not found. Website structure might be blocking automated requests.');
        }

    } catch (error) {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '⚠️ Failed to fetch details. Link might be invalid or protected.');
    }
});

bot.start();

