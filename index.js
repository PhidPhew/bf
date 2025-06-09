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
  private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

// ตรวจสอบ Firebase configuration
console.log('Firebase Config Check:');
console.log('Project ID:', process.env.FIREBASE_PROJECT_ID);
console.log('Client Email:', process.env.FIREBASE_CLIENT_EMAIL);
console.log('Private Key exists:', !!process.env.FIREBASE_PRIVATE_KEY);

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // เปลี่ยนจาก databaseURL เป็น Firestore
  });
  console.log('Firebase initialized successfully');
} catch (error) {
  console.error('Firebase initialization error:', error);
}

const db = admin.firestore();

// Fuzzy search function
async function findAnswer(question) {
  try {
    console.log('Searching for:', question);
    
    // ตรวจสอบ Firebase connection
    const snapshot = await db.collection('audio_content').get();
    console.log('Documents found:', snapshot.size);
    
    if (snapshot.empty) {
      return 'ขออภัยครับ ยังไม่มีข้อมูลในระบบ\nกรุณาเพิ่มข้อมูลใน Firestore ก่อนนะครับ';
    }

    let bestMatch = null;
    let bestScore = -Infinity;

    snapshot.forEach(doc => {
      const data = doc.data();
      console.log('Checking document:', doc.id, data);
      
      // ค้นหาจาก question field
      if (data.question) {
        const result = fuzzysort.single(question, data.question);
        if (result && result.score > bestScore) {
          bestScore = result.score;
          bestMatch = data;
          console.log('New best match from question:', result.score, data.question);
        }
      }

      // ค้นหาจาก keywords array
      if (data.keywords && Array.isArray(data.keywords)) {
        data.keywords.forEach(keyword => {
          const result = fuzzysort.single(question, keyword);
          if (result && result.score > bestScore) {
            bestScore = result.score;
            bestMatch = data;
            console.log('New best match from keyword:', result.score, keyword);
          }
        });
      }
    });

    console.log('Final best score:', bestScore);
    console.log('Final best match:', bestMatch);

    if (bestMatch && bestScore > -3000) {
      // สุ่มคำตอบระหว่าง fern_answer และ nannam_answer
      const answers = [];
      if (bestMatch.fern_answer) answers.push(`เฟิร์น: ${bestMatch.fern_answer}`);
      if (bestMatch.nannam_answer) answers.push(`น่านน้ำ: ${bestMatch.nannam_answer}`);
      
      if (answers.length > 0) {
        const selectedAnswer = answers[Math.floor(Math.random() * answers.length)];
        console.log('Selected answer:', selectedAnswer);
        return selectedAnswer;
      }
    }

    return 'ขออภัยครับ ไม่พบคำตอบสำหรับคำถามนี้ 😅\nลองถามด้วยคำง่ายๆ เช่น "ชอบอะไร" หรือ "กินอะไร"';

  } catch (error) {
    console.error('Error finding answer:', error);
    console.error('Error details:', error.message);
    return `เกิดข้อผิดพลาดครับ: ${error.message}\nกรุณาตรวจสอบการตั้งค่า Firebase`;
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
