const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const fuzzysort = require('fuzzysort');

const app = express();

// LINE Bot configuration
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

// Firebase configuration
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.asia-southeast1.firebasedatabase.app/`
});

const db = admin.firestore();

// Fuzzy search function
async function findAnswer(question) {
  try {
    const snapshot = await db.collection('audio_content').get();
    
    if (snapshot.empty) {
      return 'ขออภัยครับ ยังไม่มีข้อมูลในระบบ';
    }

    let bestMatch = null;
    let bestScore = 0;

    snapshot.forEach(doc => {
      const data = doc.data();
      
      // ค้นหาจาก question field
      if (data.question) {
        const result = fuzzysort.single(question, data.question);
        if (result && result.score > bestScore) {
          bestScore = result.score;
          bestMatch = data;
        }
      }

      // ค้นหาจาก keywords array
      if (data.keywords && Array.isArray(data.keywords)) {
        data.keywords.forEach(keyword => {
          const result = fuzzysort.single(question, keyword);
          if (result && result.score > bestScore) {
            bestScore = result.score;
            bestMatch = data;
          }
        });
      }
    });

    if (bestMatch && bestScore > -3000) { // threshold สำหรับ fuzzy matching
      // สุ่มคำตอบระหว่าง fern_answer และ nannam_answer
      const answers = [];
      if (bestMatch.fern_answer) answers.push(`เฟิร์น: ${bestMatch.fern_answer}`);
      if (bestMatch.nannam_answer) answers.push(`น่านน้ำ: ${bestMatch.nannam_answer}`);
      
      if (answers.length > 0) {
        return answers[Math.floor(Math.random() * answers.length)];
      }
    }

    return 'ขออภัยครับ ไม่พบคำตอบสำหรับคำถามนี้ 😅\nลองถามใหม่ด้วยคำที่ง่ายๆ หน่อยนะครับ';

  } catch (error) {
    console.error('Error finding answer:', error);
    return 'เกิดข้อผิดพลาดครับ กรุณาลองใหม่อีกครั้ง';
  }
}

// Handle events
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text.trim();
  
  // หาคำตอบจาก Firebase
  const answer = await findAnswer(userMessage);

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: answer
  });
}

// Middleware
app.use('/webhook', line.middleware(config));

// Routes
app.get('/', (req, res) => {
  res.send('LINE Bot is running! 🎉');
});

app.post('/webhook', (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});