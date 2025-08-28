const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios'); // Added axios for better HTTP requests
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const token = process.env.TELEGRAM_BOT_TOKEN;

// Check if token exists
if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN not found in environment variables');
    process.exit(1);
}

console.log('🤖 Starting bot with token:', token.substring(0, 10) + '...');

// Initialize bot with polling
const bot = new TelegramBot(token, { polling: true });

// Simple in-memory database for testing
let users = new Map();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Test the bot connection
bot.getMe().then((botInfo) => {
    console.log('✅ Bot connected successfully!');
    console.log('Bot info:', {
        id: botInfo.id,
        first_name: botInfo.first_name,
        username: botInfo.username
    });
}).catch((error) => {
    console.error('❌ Bot connection failed:', error.message);
});

// Error handling for polling
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message);
});

// Start command handler
bot.onText(/\/start/, async (msg) => {
    console.log('📨 Received /start command from:', msg.from);
    
    const chatId = msg.chat.id;
    const user = msg.from;
    
    // Store user info
    users.set(user.id, {
        telegram_id: user.id,
        username: user.username,
        first_name: user.first_name,
        subscription_type: 'free',
        daily_usage: 0,
        total_usage: 0,
        created_at: new Date().toISOString()
    });
    
    const welcomeMessage = `🎬 *Welcome to VideoShortsBot!*

Transform long videos into viral shorts instantly!

*YOUR PLAN: FREE*

📊 *Today's Usage:* 0/3 (Free)
📈 *Total Processed:* 0 videos

🆓 *FREE FEATURES:*
• 3 videos per day
• 60-second shorts
• YouTube & TikTok support

💎 *PREMIUM ($2.99/month):*
• ✅ Unlimited videos
• ✅ Custom lengths (15s-90s)
• ✅ All platforms + Instagram
• ✅ Priority processing

🚀 *PRO ($9.99/month):*
• ✅ Everything in Premium
• ✅ API access
• ✅ White-label rights
• ✅ Custom branding

*Ready? Send me any video URL!*

Commands:
/upgrade - View premium plans
/stats - Your statistics  
/help - Need assistance?`;
    
    try {
        await bot.sendMessage(chatId, welcomeMessage, { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{text: '💎 Upgrade Now', callback_data: 'upgrade'}],
                    [{text: '📊 My Stats', callback_data: 'stats'}],
                    [{text: '❓ Help', callback_data: 'help'}]
                ]
            }
        });
        console.log('✅ Welcome message sent to', user.first_name);
    } catch (error) {
        console.error('❌ Error sending welcome message:', error.message);
    }
});

// Help command
bot.onText(/\/help/, async (msg) => {
    const helpMessage = `❓ *How to use VideoShortsBot:*

1️⃣ Send any video URL from:
   • YouTube
   • TikTok
   • Instagram (Premium)

2️⃣ Wait 1-3 minutes for processing

3️⃣ Receive your viral shorts!

*Supported formats:*
• https://youtube.com/watch?v=...
• https://youtu.be/...
• https://tiktok.com/@user/video/...
• https://instagram.com/p/... (Premium)

*Need more help?*
Contact: @Osezblessed`;

    bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
});

// Stats command
bot.onText(/\/stats/, async (msg) => {
    const userId = msg.from.id;
    const userData = users.get(userId) || {
        subscription_type: 'free',
        daily_usage: 0,
        total_usage: 0,
        created_at: new Date().toISOString()
    };
    
    const statsMessage = `📊 *YOUR STATISTICS*

👤 *Account:* ${msg.from.first_name}
💳 *Plan:* ${userData.subscription_type.toUpperCase()}

📈 *Usage Today:* ${userData.daily_usage}/${userData.subscription_type === 'free' ? '3' : '∞'}
🎬 *Total Processed:* ${userData.total_usage} videos
📅 *Member Since:* ${new Date(userData.created_at).toLocaleDateString()}

${userData.subscription_type === 'free' ? 
    '🔓 *Want unlimited access?* /upgrade' : 
    '✅ *Premium active*'
}`;
    
    bot.sendMessage(msg.chat.id, statsMessage, { parse_mode: 'Markdown' });
});

// Handle video URLs
bot.on('message', async (msg) => {
    // Skip if it's a command
    if (msg.text && msg.text.startsWith('/')) return;
    
    if (msg.text && (
        msg.text.includes('youtube.com') || 
        msg.text.includes('youtu.be') || 
        msg.text.includes('tiktok.com') || 
        msg.text.includes('instagram.com')
    )) {
        console.log('📹 Video URL received:', msg.text);
        
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const userData = users.get(userId) || { daily_usage: 0, subscription_type: 'free' };
        
        // Check limits for free users
        if (userData.subscription_type === 'free' && userData.daily_usage >= 3) {
            const limitMessage = `🚫 *Daily limit reached!*

You've used your 3 free videos today.

💎 *Upgrade to Premium for:*
• ✅ Unlimited videos
• ✅ Priority processing  
• ✅ All platforms
• ✅ Custom lengths

Ready to upgrade? /upgrade`;
            
            return bot.sendMessage(chatId, limitMessage, { 
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{text: '💎 Upgrade Now - $2.99', callback_data: 'upgrade_premium'}]
                    ]
                }
            });
        }
        
        // Send processing message
        await bot.sendMessage(chatId, '🎬 Processing your video... This may take 1-3 minutes.');
        
        // Update usage
        userData.daily_usage = (userData.daily_usage || 0) + 1;
        userData.total_usage = (userData.total_usage || 0) + 1;
        users.set(userId, userData);
        
        // Call N8N webhook to process video using axios
        try {
            const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL || 'https://n8n-on-render-wf30.onrender.com/webhook/video-processing';
            const webhookSecret = process.env.N8N_WEBHOOK_SECRET || '7f9d0d2e8a6f4f38a13a2bcf5b6d441b91c9d26e8b72714d2edcf7c4e2a843ke';
            const businessBotUrl = process.env.BUSINESS_BOT_URL || 'https://video-shorts-business-bot.onrender.com';
            
            console.log('🔄 Calling N8N webhook:', n8nWebhookUrl);
            
            const payload = {
                webhook_secret: webhookSecret,
                telegram_id: userId,
                chat_id: chatId,
                video_url: msg.text,
                user_name: msg.from.first_name,
                subscription_type: userData.subscription_type || 'free',
                user_limits: { max_shorts: 3 },
                business_bot_url: businessBotUrl
            };
            
            console.log('📤 Sending payload to N8N:', JSON.stringify(payload, null, 2));
            
            const n8nResponse = await axios.post(n8nWebhookUrl, payload, {
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 10000 // 10 second timeout
            });
            
            console.log('✅ N8N webhook called successfully:', n8nResponse.data);
            
        } catch (error) {
            console.error('❌ Error calling N8N:', error.message);
            if (error.response) {
                console.error('❌ N8N Response status:', error.response.status);
                console.error('❌ N8N Response data:', error.response.data);
            }
            await bot.sendMessage(chatId, '❌ Processing failed. Please try again later or contact support.\n\nSupport: @Osezblessed');
        }
    }
});

// Handle callback queries (inline button presses)
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    
    switch (data) {
        case 'upgrade':
        case 'upgrade_premium':
            const upgradeMessage = `💎 *UPGRADE YOUR EXPERIENCE*

💰 *NIGERIAN PRICING* 🇳🇬

💎 *Premium - ₦1,200/month*
• Unlimited video processing
• All platforms (Instagram, Twitter)
• Priority processing
• Custom video lengths

🚀 *Pro - ₦4,000/month*
• Everything in Premium  
• API access
• White-label rights
• Custom branding
• Reseller opportunities

💳 *Payment Methods:*
• Debit Card (Visa, Mastercard)
• Bank Transfer
• USSD Code

Contact @Osezblessed for payment`;
            
            bot.editMessageText(upgradeMessage, {
                chat_id: message.chat.id,
                message_id: message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{text: '💬 Contact Support', url: 'https://t.me/Osezblessed'}],
                        [{text: '🔙 Back', callback_data: 'back_to_start'}]
                    ]
                }
            });
            break;
            
        case 'stats':
            const userId = callbackQuery.from.id;
            const userData = users.get(userId) || {
                subscription_type: 'free',
                daily_usage: 0,
                total_usage: 0
            };
            
            const statsMessage = `📊 *YOUR STATISTICS*

👤 *Account:* ${callbackQuery.from.first_name}
💳 *Plan:* ${userData.subscription_type.toUpperCase()}

📈 *Usage Today:* ${userData.daily_usage}/3
🎬 *Total Processed:* ${userData.total_usage} videos

${userData.subscription_type === 'free' ? 
    '🔓 *Want unlimited access?* Upgrade now!' : 
    '✅ *Premium active*'
}`;
            
            bot.editMessageText(statsMessage, {
                chat_id: message.chat.id,
                message_id: message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{text: '💎 Upgrade', callback_data: 'upgrade'}],
                        [{text: '🔙 Back', callback_data: 'back_to_start'}]
                    ]
                }
            });
            break;
            
        case 'help':
            const helpMessage = `❓ *How to use VideoShortsBot:*

1️⃣ Send any video URL from:
   • YouTube
   • TikTok  
   • Instagram (Premium)

2️⃣ Wait 1-3 minutes for processing

3️⃣ Receive your viral shorts!

*Need more help?*
Contact: @Osezblessed`;
            
            bot.editMessageText(helpMessage, {
                chat_id: message.chat.id,
                message_id: message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{text: '💬 Contact Support', url: 'https://t.me/Osezblessed'}],
                        [{text: '🔙 Back', callback_data: 'back_to_start'}]
                    ]
                }
            });
            break;
            
        case 'back_to_start':
            const originalMessage = `🎬 *Welcome to VideoShortsBot!*

Transform long videos into viral shorts instantly!

*Ready? Send me any video URL!*`;
            
            bot.editMessageText(originalMessage, {
                chat_id: message.chat.id,
                message_id: message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{text: '💎 Upgrade Now', callback_data: 'upgrade'}],
                        [{text: '📊 My Stats', callback_data: 'stats'}],
                        [{text: '❓ Help', callback_data: 'help'}]
                    ]
                }
            });
            break;
    }
    
    // Answer the callback query to remove the loading state
    bot.answerCallbackQuery(callbackQuery.id);
});

// Webhook endpoints for N8N callbacks
app.post('/webhook/n8n-callback', async (req, res) => {
    console.log('📦 Received callback from N8N:', JSON.stringify(req.body, null, 2));
    
    try {
        const { 
            telegram_id, 
            chat_id, 
            status, 
            shorts_results, 
            total_shorts, 
            subscription_type,
            processing_completed_at,
            usage_stats
        } = req.body;
        
        if (status === 'completed' && shorts_results) {
            // Parse shorts_results if it's a string
            const results = typeof shorts_results === 'string' ? 
                JSON.parse(shorts_results) : shorts_results;
            
            let message = `✅ *Your ${total_shorts} shorts are ready!*\n\n`;
            
            results.forEach((short, index) => {
                message += `🎬 *Short ${index + 1}:* ${short.title}\n`;
                message += `⏱️ Duration: ${short.duration}s\n`;
                message += `📱 Quality: ${short.quality}\n`;
                
                if (short.file_url) {
                    message += `📥 [Download](${short.file_url})\n`;
                }
                if (short.thumbnail_url) {
                    message += `🖼️ [Thumbnail](${short.thumbnail_url})\n`;
                }
                message += `\n`;
            });
            
            if (subscription_type === 'free') {
                message += `🚀 *Upgrade to Premium for:*\n• No watermarks\n• HD quality\n• Unlimited processing\n\n/upgrade`;
            }
            
            // Add processing stats if available
            if (usage_stats) {
                message += `\n📊 *Processing completed in ${usage_stats.processing_time}*`;
            }
            
            await bot.sendMessage(chat_id, message, { 
                parse_mode: 'Markdown',
                disable_web_page_preview: false
            });
            
            console.log('✅ Results sent to user:', telegram_id);
            
        } else {
            console.log('❌ Invalid callback data received');
            await bot.sendMessage(chat_id, '❌ Processing completed but results are unavailable. Please try again.');
        }
        
        res.json({ status: 'success', message: 'Callback processed successfully' });
        
    } catch (error) {
        console.error('❌ Error processing N8N callback:', error.message);
        console.error('Full error:', error);
        
        // Try to send error message to user if we have chat_id
        if (req.body.chat_id) {
            try {
                await bot.sendMessage(req.body.chat_id, '❌ There was an error delivering your results. Please contact support.\n\nSupport: @Osezblessed');
            } catch (botError) {
                console.error('❌ Failed to send error message to user:', botError.message);
            }
        }
        
        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to process callback',
            error: error.message 
        });
    }
});

app.post('/webhook/n8n-error', async (req, res) => {
    console.log('❌ N8N error received:', JSON.stringify(req.body, null, 2));
    
    try {
        const { 
            chat_id, 
            telegram_id, 
            error_message, 
            processing_id, 
            video_url,
            error_type 
        } = req.body;
        
        const errorMsg = `❌ *Processing Failed*

*Error:* ${error_message || 'Unknown error occurred'}

🔄 *What to do:*
• Check if the video URL is valid
• Try again in a few minutes  
• Contact support if issue persists

📝 *Processing ID:* ${processing_id || 'N/A'}

Support: @Osezblessed`;
        
        await bot.sendMessage(chat_id, errorMsg, { parse_mode: 'Markdown' });
        
        console.log('✅ Error notification sent to user:', telegram_id);
        
        res.json({ status: 'success', message: 'Error notification sent' });
        
    } catch (error) {
        console.error('❌ Error handling N8N error callback:', error.message);
        
        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to handle error callback',
            error: error.message 
        });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'Bot is running!', 
        timestamp: new Date(),
        bot_username: '@videoshortsaibot',
        endpoints: [
            '/webhook/n8n-callback',
            '/webhook/n8n-error'
        ]
    });
});

// Test endpoint for debugging
app.get('/test', (req, res) => {
    res.json({
        environment: {
            NODE_ENV: process.env.NODE_ENV,
            PORT: process.env.PORT,
            TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ? 'Set' : 'Missing',
            N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || 'Using default',
            N8N_WEBHOOK_SECRET: process.env.N8N_WEBHOOK_SECRET ? 'Set' : 'Using default',
            BUSINESS_BOT_URL: process.env.BUSINESS_BOT_URL || 'Using default'
        },
        stats: {
            total_users: users.size,
            uptime: process.uptime()
        }
    });
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Bot server running on port ${PORT}`);
    console.log(`Bot username: @videoshortsaibot`);
    console.log(`Bot URL: https://video-shorts-business-bot.onrender.com`);
    console.log(`Health check: https://video-shorts-business-bot.onrender.com/`);
    console.log(`Test endpoint: https://video-shorts-business-bot.onrender.com/test`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Shutting down bot...');
    bot.stopPolling();
    process.exit();
});

process.on('SIGTERM', () => {
    console.log('🛑 Shutting down bot...');
    bot.stopPolling();
    process.exit();
});