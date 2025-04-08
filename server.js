require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL pool configuration from .env
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

// Load bot token from .env file
const botToken = process.env.BOT_API;
if (!botToken) {
  console.error("BOT_API token not found in .env");
  process.exit(1);
}

// Set up Telegram Bot with polling
const bot = new TelegramBot(botToken, { polling: true });

// In-memory store for OTPs and active sessions (phone -> sessionID)
let otpStore = {};
let activeSessions = {};

// In-memory rate-limit tracker for OTP requests (phoneNumber -> array of timestamps)
const otpRequests = {}; 
const OTP_LIMIT = 5;
const OTP_WINDOW = 15 * 60 * 1000; // 15 minutes in milliseconds

// Middlewares
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware
app.use(session({
  secret: 'your_secret_key_here',
  resave: false,
  saveUninitialized: true
}));

// -----------------------------------------
// Database helper functions for "users" table
// -----------------------------------------
async function getUserByChatId(chatId) {
  const result = await pool.query('SELECT * FROM users WHERE chatid = $1', [chatId]);
  return result.rows[0];
}

async function getUserByPhone(phoneNumber) {
  const result = await pool.query('SELECT * FROM users WHERE phonenumber = $1', [phoneNumber]);
  return result.rows[0];
}

/*
  Modified createOrUpdateUser:
  - If a user exists by chat id and the phone number is different, update the record.
  - Otherwise, try to find a user by phone number and update chat id if needed,
    or create a new record if none is found.
*/
async function createOrUpdateUser({ name, phoneNumber, chatId }) {
  const existingByChat = await getUserByChatId(chatId);
  if (existingByChat) {
    if (existingByChat.phonenumber !== phoneNumber) {
      const updateResult = await pool.query(
        'UPDATE users SET phonenumber = $1, name = $2 WHERE chatid = $3 RETURNING *',
        [phoneNumber, name, chatId]
      );
      return updateResult.rows[0];
    }
    return existingByChat;
  } else {
    const existingByPhone = await getUserByPhone(phoneNumber);
    if (existingByPhone) {
      if (existingByPhone.chatid !== chatId) {
        const updateResult = await pool.query(
          'UPDATE users SET chatid = $1, name = $2 WHERE phonenumber = $3 RETURNING *',
          [chatId, name, phoneNumber]
        );
        return updateResult.rows[0];
      }
      return existingByPhone;
    } else {
      const insertResult = await pool.query(
        'INSERT INTO users (name, phonenumber, chatid) VALUES ($1, $2, $3) RETURNING *',
        [name, phoneNumber, chatId]
      );
      return insertResult.rows[0];
    }
  }
}

// -----------------------------------------
// Telegram Bot Handlers
// -----------------------------------------

// /start command to register user
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const existingUser = await getUserByChatId(chatId);
    if (existingUser) {
      bot.sendMessage(chatId, "You are already registered. Now login on the website with your number.");
    } else {
      const options = {
        reply_markup: {
          keyboard: [
            [{
              text: "Share Contact",
              request_contact: true
            }]
          ],
          one_time_keyboard: true,
          resize_keyboard: true
        }
      };
      bot.sendMessage(chatId, "Welcome! Please share your phone number:", options);
    }
  } catch (error) {
    console.error("Error in /start handler:", error);
  }
});

// When user shares their contact, store or update data in PostgreSQL.
bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const contact = msg.contact;
  const phoneNumber = contact.phone_number;
  const firstName = contact.first_name || "";
  const lastName = contact.last_name || "";
  const name = `${firstName} ${lastName}`.trim();

  try {
    await createOrUpdateUser({ name, phoneNumber, chatId });
    bot.sendMessage(chatId, "Thank you! Your contact has been saved. Now you can log in on the website using your phone number.");
  } catch (error) {
    console.error("Error saving contact:", error);
    bot.sendMessage(chatId, "There was an error saving your contact. Please try again later.");
  }
});

// -----------------------------------------
// Owner Broadcast Handler
// -----------------------------------------
bot.on('message', async (msg) => {
  if (!process.env.OWNER_IDS) return;
  const ownerIds = process.env.OWNER_IDS.split(',').map(id => id.trim());
  const senderId = msg.chat.id.toString();

  if (!ownerIds.includes(senderId)) return;

  // Forwarded messages are broadcast without command filtering.
  if (msg.forward_from || msg.forward_sender_name) {
    try {
      const result = await pool.query('SELECT chatid FROM users');
      const users = result.rows;
      for (const user of users) {
        bot.forwardMessage(user.chatid, msg.chat.id, msg.message_id);
      }
    } catch (error) {
      console.error("Error broadcasting forwarded message:", error);
    }
    return;
  }

  // Process direct owner messages only if they start with "/send"
  if ((msg.text && msg.text.startsWith('/send')) || (msg.caption && msg.caption.startsWith('/send'))) {
    let broadcastText = "";
    if (msg.text && msg.text.startsWith('/send')) {
      broadcastText = msg.text.substring(5).trim();
    }
    let broadcastCaption = "";
    if (msg.caption && msg.caption.startsWith('/send')) {
      broadcastCaption = msg.caption.substring(5).trim();
    } else if (msg.caption) {
      broadcastCaption = msg.caption;
    }

    try {
      const result = await pool.query('SELECT chatid FROM users');
      const users = result.rows;
      if (!msg.photo && !msg.video && !msg.document && !msg.audio && !msg.voice && !msg.sticker) {
        for (const user of users) {
          bot.sendMessage(user.chatid, broadcastText);
        }
      } else {
        const options = { caption: broadcastCaption || broadcastText };
        for (const user of users) {
          if (msg.photo) {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            bot.sendPhoto(user.chatid, fileId, options);
          } else if (msg.video) {
            bot.sendVideo(user.chatid, msg.video.file_id, options);
          } else if (msg.document) {
            bot.sendDocument(user.chatid, msg.document.file_id, options);
          } else if (msg.audio) {
            bot.sendAudio(user.chatid, msg.audio.file_id, options);
          } else if (msg.voice) {
            bot.sendVoice(user.chatid, msg.voice.file_id, options);
          } else if (msg.sticker) {
            bot.sendSticker(user.chatid, msg.sticker.file_id);
          } else {
            bot.sendMessage(user.chatid, broadcastText);
          }
        }
      }
    } catch (error) {
      console.error("Error broadcasting /send message:", error);
    }
  }
});

// -----------------------------------------
// Web Routes
// -----------------------------------------

// Serve the login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// POST route to request an OTP with rate limiting
app.post('/request-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.json({ success: false, message: "Phone number is required" });
  }

  // Rate limit check: allow only 5 OTP requests per 15 minutes.
  const now = Date.now();
  if (!otpRequests[phoneNumber]) {
    otpRequests[phoneNumber] = [];
  }
  // Remove timestamps older than 15 minutes.
  otpRequests[phoneNumber] = otpRequests[phoneNumber].filter(timestamp => now - timestamp < OTP_WINDOW);
  if (otpRequests[phoneNumber].length >= OTP_LIMIT) {
    return res.json({ success: false, message: "OTP request limit reached. Please try again later." });
  }
  otpRequests[phoneNumber].push(now);

  try {
    const user = await getUserByPhone(phoneNumber);
    if (!user) {
      return res.json({ success: false, message: "User not found. Please start the bot and share your contact." });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = otp;
    bot.sendMessage(user.chatid, `Your OTP is: \`${otp}\``, { parse_mode: "Markdown" });
    res.json({ success: true, message: "OTP sent in Telegram." });
  } catch (error) {
    console.error("Error in /request-otp:", error);
    res.json({ success: false, message: "Internal server error." });
  }
});

// POST route to verify OTP and sign in the user
app.post('/verify-otp', async (req, res) => {
  const { phoneNumber, otp } = req.body;
  if (!phoneNumber || !otp) {
    return res.json({ success: false, message: "Phone number and OTP are required" });
  }
  if (otpStore[phoneNumber] !== otp) {
    return res.json({ success: false, message: "Invalid OTP" });
  }

  if (activeSessions[phoneNumber] && activeSessions[phoneNumber] !== req.session.id) {
    req.sessionStore.destroy(activeSessions[phoneNumber], (err) => {
      if (err) console.error("Error destroying previous session:", err);
    });
  }
  
  activeSessions[phoneNumber] = req.session.id;
  req.session.phoneNumber = phoneNumber;
  delete otpStore[phoneNumber];
  res.json({ success: true, message: "Successfully signed in" });
});

// Protected homepage with Logout button
app.get('/', (req, res) => {
  if (!req.session.phoneNumber) {
    return res.redirect('/login');
  }
  res.send(`
    <h1>Welcome, ${req.session.phoneNumber}!</h1>
    <p>You are logged in.</p>
    <form action="/logout" method="POST">
      <button type="submit" class="btn btn-danger">Logout</button>
    </form>
  `);
});

// Logout route
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Error destroying session:", err);
    res.redirect('/login');
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
