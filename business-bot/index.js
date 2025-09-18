const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { CronJob } = require('cron');

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const N8N_WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET;

// Initialize Telegram bot in webhook mode
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const webhookPath = `/webhook/${TELEGRAM_BOT_TOKEN}`;
bot.setWebHook(`${RENDER_EXTERNAL_URL}${webhookPath}`);

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const upload = multer({ storage: multer.memoryStorage() });

app.set('trust proxy', true);

// Rate limiting for webhook endpoint
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit to 100 requests per window
});
app.use('/webhook', limiter);

// Handle /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id.toString();

  // Check if user exists in Supabase
  let { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error checking user:', error);
    await bot.sendMessage(chatId, 'An error occurred. Please try again later.');
    return;
  }

  // Create user if not exists
  if (!user) {
    const { error: insertError } = await supabase
      .from('users')
      .insert({
        telegram_id: telegramId,
        subscription_type: 'free',
        subscription_expires_at: null,
        created_at: new Date().toISOString(),
      });

    if (insertError) {
      console.error('Error creating user:', insertError);
      await bot.sendMessage(chatId, 'Failed to register user. Please try again.');
      return;
    }

    user = { telegram_id: telegramId, subscription_type: 'free', subscription_expires_at: null };
  }

  await bot.sendMessage(
    chatId,
    'Welcome to the Video Shorts Bot! Send a video (up to 200MB) to process it into shorts.'
  );
});

// Handle video uploads
bot.on('video', async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id.toString();
  const fileId = msg.video.file_id;
  const fileSize = msg.video.file_size;

  // Check file size (200MB limit)
  if (fileSize > 200 * 1024 * 1024) {
    await bot.sendMessage(chatId, 'Video is too large. Please upload a video under 200MB.');
    return;
  }

  // Check user in Supabase
  const { data: user, error } = await supabase
    .from('users')
    .select('subscription_type, subscription_expires_at')
    .eq('telegram_id', telegramId)
    .single();

  if (error) {
    console.error('Error fetching user:', error);
    await bot.sendMessage(chatId, 'Error verifying user. Please try again.');
    return;
  }

  if (!user) {
    await bot.sendMessage(chatId, 'Please use /start to register before uploading videos.');
    return;
  }

  // Check subscription status
  if (user.subscription_type === 'premium' && user.subscription_expires_at) {
    const subscriptionEnd = new Date(user.subscription_expires_at);
    if (subscriptionEnd < new Date()) {
      await supabase
        .from('users')
        .update({ subscription_type: 'free', subscription_expires_at: null })
        .eq('telegram_id', telegramId);
      user.subscription_type = 'free';
    }
  }

  // Generate processing ID
  const processingId = uuidv4();

  // Send video metadata to n8n workflow
  try {
    await bot.sendMessage(chatId, 'Video accepted for processing. Please wait...');

    const formData = new FormData();
    formData.append('file_id', fileId);
    formData.append('processing_id', processingId);
    formData.append('telegram_id', telegramId);
    formData.append('chat_id', chatId.toString());
    formData.append('subscription_type', user.subscription_type);
    formData.append('callback_url', `${RENDER_EXTERNAL_URL}/webhook/n8n-callback`);

    const processorResponse = await axios.post(
      'https://n8n-on-render-wf30.onrender.com/webhook/video-processing',
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${N8N_WEBHOOK_SECRET}`,
        },
        timeout: 30000,
      }
    );

    if (processorResponse.data.status === 'success') {
      await bot.sendMessage(chatId, 'Video processing initiated. You will receive results soon.');
    } else {
      throw new Error(processorResponse.data.error || 'Processing initiation failed.');
    }
  } catch (error) {
    console.error('Error sending to n8n:', error.message);
    await bot.sendMessage(chatId, 'Failed to initiate video processing. Please try again.');
  }
});

// Express endpoint for n8n callback
app.post('/webhook/n8n-callback', async (req, res) => {
  const {
    processing_id,
    telegram_id,
    chat_id,
    status,
    shorts_results,
    thumbnail_url,
    error,
  } = req.body;

  if (!processing_id || !telegram_id || !chat_id) {
    console.error('Invalid callback data:', req.body);
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    if (status === 'success' && shorts_results && thumbnail_url) {
      // Send thumbnail
      await bot.sendPhoto(chat_id, thumbnail_url, { caption: 'Processing complete! Here is your thumbnail.' });

      // Send shorts (assuming shorts_results contains URLs)
      for (const short of shorts_results) {
        await bot.sendVideo(chat_id, short.url, { caption: 'Here is one of your processed shorts.' });
      }

      await bot.sendMessage(chat_id, 'All shorts have been sent. Upload another video to process more!');
    } else {
      console.error('Processing failed:', error);
      await bot.sendMessage(chat_id, `Processing failed: ${error || 'Unknown error'}`);
    }

    res.status(200).json({ status: 'received' });
  } catch (err) {
    console.error('Error handling callback:', err.message);
    res.status(500).json({ error: 'Failed to process callback' });
  }
});

// Webhook endpoint for Telegram
app.post(webhookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.status(200).send('OK');
});

// Cron job to check subscription expirations (runs daily at midnight)
const job = new CronJob('0 0 * * *', async () => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('telegram_id, subscription_expires_at, subscription_type')
      .eq('subscription_type', 'premium');

    if (error) throw error;

    const now = new Date();
    for (const user of users) {
      if (user.subscription_expires_at && new Date(user.subscription_expires_at) < now) {
        await supabase
          .from('users')
          .update({ subscription_type: 'free', subscription_expires_at: null })
          .eq('telegram_id', user.telegram_id);
        await bot.sendMessage(
          user.telegram_id,
          'Your premium subscription has expired. You are now on the free plan.'
        );
      }
    }
  } catch (error) {
    console.error('Error in subscription cron job:', error);
  }
});
job.start();

// Start Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});