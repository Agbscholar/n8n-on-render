const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
  constructor() {
    this.db = new sqlite3.Database('./data.db');
    this.init();
  }

  init() {
    // Users table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        telegram_id INTEGER UNIQUE,
        username TEXT,
        first_name TEXT,
        subscription_type TEXT DEFAULT 'free',
        subscription_expires DATE,
        daily_usage INTEGER DEFAULT 0,
        total_usage INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Usage logs table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        video_url TEXT,
        platform TEXT,
        status TEXT,
        shorts_created INTEGER DEFAULT 0,
        processing_time INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (telegram_id)
      )
    `);

    // Reset daily usage at midnight
    this.resetDailyUsage();
  }

  async getUser(telegramId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT * FROM users WHERE telegram_id = ?", 
        [telegramId], 
        (err, row) => {
          if (err) reject(err);
          resolve(row);
        }
      );
    });
  }

  async createUser(userData) {
    return new Promise((resolve, reject) => {
      const { telegram_id, username, first_name } = userData;
      this.db.run(
        "INSERT OR IGNORE INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)",
        [telegram_id, username, first_name],
        function(err) {
          if (err) reject(err);
          resolve(this.lastID);
        }
      );
    });
  }

  async canUseService(telegramId) {
    const user = await this.getUser(telegramId);
    if (!user) return false;
    
    // Premium users have unlimited access
    if (user.subscription_type === 'premium' || user.subscription_type === 'pro') {
      return new Date() < new Date(user.subscription_expires);
    }
    
    // Free users have daily limits
    return user.daily_usage < 3;
  }

  async logUsage(telegramId, videoData) {
    return new Promise((resolve, reject) => {
      // Update user usage
      this.db.run(
        "UPDATE users SET daily_usage = daily_usage + 1, total_usage = total_usage + 1 WHERE telegram_id = ?",
        [telegramId]
      );

      // Log the usage
      this.db.run(
        "INSERT INTO usage_logs (user_id, video_url, platform, status, shorts_created, processing_time) VALUES (?, ?, ?, ?, ?, ?)",
        [telegramId, videoData.url, videoData.platform, videoData.status, videoData.shorts_created, videoData.processing_time],
        function(err) {
          if (err) reject(err);
          resolve(this.lastID);
        }
      );
    });
  }

  resetDailyUsage() {
    // Reset at midnight
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const msUntilMidnight = tomorrow.getTime() - now.getTime();
    
    setTimeout(() => {
      this.db.run("UPDATE users SET daily_usage = 0");
      // Schedule next reset (24 hours)
      setInterval(() => {
        this.db.run("UPDATE users SET daily_usage = 0");
      }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }
}

module.exports = new Database();