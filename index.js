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

// Firebase configuration - ใช้ variables แยกกัน
console.log('Initializing Firebase...');

// ตรวจสอบ environment variables
const requiredEnvVars = [
  'CHANNEL_ACCESS_TOKEN',
  'CHANNEL_SECRET',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_CLIENT_ID',
  'FIREBASE_PRIVATE_KEY_ID',
  'FIREBASE_CLIENT_CERT_URL'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingVars);
  process.exit(1);
}

// สร้าง service account object
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  // แปลง \\n เป็น newline จริง และลบ quotes ที่อาจจะติดมา
  private_key: process.env.FIREBASE_PRIVATE_KEY
    .replace(/\\n/g, '\n')
    .replace(/^"/, '')
    .replace(/"$/, ''),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

console.log('✅ Service account configured');
console.log('📧 Client email:', serviceAccount.client_email);
console.log('🔑 Project ID:', serviceAccount.project_id);
console.log('🔐 Private key length:', serviceAccount.private_key.length);

// Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}-default-rtdb.asia-southeast1.firebasedatabase.app/`
  });
  console.log('✅ Firebase initialized successfully');
} catch (error) {
  console.error('❌ Firebase initialization error:', error.message);
  console.error('Full error:', error);
  process.exit(1);
}

const db = admin.firestore();

// Test Firestore connection - ตรวจสอบ preferences collection
async function testFirestoreConnection() {
  try {
    console.log('🔍 Testing Firestore connection...');
    
    // ตรวจสอบ collection preferences
    const preferencesSnapshot = await db.collection('preferences').get();
    console.log('📄 Documents in preferences collection:', preferencesSnapshot.size);
    
    // แสดงรายชื่อ documents ทั้งหมด
    const docNames = [];
    preferencesSnapshot.forEach(doc => {
      docNames.push(doc.id);
    });
    console.log('📋 Document names:', docNames);
    
    // ตรวจสอบ audio_content document
    const audioContentDoc = await db.collection('preferences').doc('audio_content').get();
    if (audioContentDoc.exists) {
      console.log('🎵 audio_content document exists');
      const data = audioContentDoc.data();
      console.log('📝 Sample fields:', Object.keys(data));
    }
    
    console.log('✅ Firestore connection successful');
    
  } catch (error) {
    console.error('❌ Firestore connection failed:', error.message);
    console.error('Error code:', error.code);
  }
}

// Test connection on startup
testFirestoreConnection();

// ปรับปรุง Fuzzy search function ให้ค้นหาจาก preferences collection
async function findAnswer(question) {
  try {
    console.log('🔍 Searching for:', question);
    
    // ค้นหาจากทุก documents ใน preferences collection
    const preferencesSnapshot = await db.collection('preferences').get();
    
    if (preferencesSnapshot.empty) {
      console.log('📭 No documents found in preferences collection');
      return 'ขออภัยครับ ยังไม่มีข้อมูลในระบบ';
    }

    console.log('📄 Documents in preferences collection:', preferencesSnapshot.size);

    let bestMatch = null;
    let bestScore = -Infinity;
    let bestDocId = '';

    // วนลูปค้นหาจากทุก documents
    preferencesSnapshot.forEach(doc => {
      const data = doc.data();
      const docId = doc.id;
      
      console.log(`🔍 Checking document: ${docId}`);
      
      // ค้นหาจาก question field
      if (data.question) {
        const result = fuzzysort.single(question, data.question);
        if (result && result.score > bestScore) {
          bestScore = result.score;
          bestMatch = data;
          bestDocId = docId;
          console.log(`📈 New best match from question in ${docId}: score ${result.score}`);
        }
      }

      // ค้นหาจาก keywords array
      if (data.keywords && Array.isArray(data.keywords)) {
        data.keywords.forEach((keyword, index) => {
          const result = fuzzysort.single(question, keyword);
          if (result && result.score > bestScore) {
            bestScore = result.score;
            bestMatch = data;
            bestDocId = docId;
            console.log(`📈 New best match from keyword[${index}] "${keyword}" in ${docId}: score ${result.score}`);
          }
        });
      }
    });

    console.log('🎯 Final best match score:', bestScore);
    console.log('📄 Best match from document:', bestDocId);

    // ใช้ threshold ที่เหมาะสม
    if (bestMatch && bestScore > -3000) {
      // สุ่มคำตอบระหว่าง fern_answer และ nannam_answer
      const answers = [];
      if (bestMatch.fern_answer) answers.push(`เฟิร์น: ${bestMatch.fern_answer}`);
      if (bestMatch.nannam_answer) answers.push(`น่านน้ำ: ${bestMatch.nannam_answer}`);
      
      if (answers.length > 0) {
        const selectedAnswer = answers[Math.floor(Math.random() * answers.length)];
        console.log('✅ Answer found:', selectedAnswer.substring(0, 50) + '...');
        return selectedAnswer;
      } else {
        console.log('⚠️ Match found but no answers available');
        return `พบข้อมูลเกี่ยวกับ "${bestMatch.question || 'คำถามนี้'}" แต่ยังไม่มีคำตอบครับ 😅`;
      }
    }

    console.log('❌ No matching answer found');
    return 'ขออภัยครับ ไม่พบคำตอบสำหรับคำถามนี้ 😅\nลองถามใหม่ด้วยคำที่ง่ายๆ หน่อยนะครับ';

  } catch (error) {
    console.error('❌ Error finding answer:', error);
    console.error('Error details:', error.message);
    return 'เกิดข้อผิดพลาดครับ กรุณาลองใหม่อีกครั้ง 🙏';
  }
}

// Handle events
async function handleEvent(event) {
  try {
    if (event.type !== 'message' || event.message.type !== 'text') {
      return Promise.resolve(null);
    }

    const userMessage = event.message.text.trim();
    console.log('💬 Received message:', userMessage);
    
    // หาคำตอบจาก Firebase
    const answer = await findAnswer(userMessage);

    console.log('📤 Sending reply...');
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: answer
    });
  } catch (error) {
    console.error('❌ Error handling event:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'เกิดข้อผิดพลาดครับ กรุณาลองใหม่อีกครั้ง 🙏'
    });
  }
}

// Middleware
app.use('/webhook', line.middleware(config));

// Routes
app.get('/', (req, res) => {
  res.send(`
    <h1>LINE Bot is running! 🎉</h1>
    <p>Firebase Status: ✅ Connected</p>
    <p>Project ID: ${process.env.FIREBASE_PROJECT_ID}</p>
    <p>Server Time: ${new Date().toISOString()}</p>
  `);
});

app.post('/webhook', (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => {
      console.log('✅ Webhook processed successfully');
      res.json(result);
    })
    .catch((err) => {
      console.error('❌ Webhook error:', err);
      res.status(500).end();
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    firebase: 'connected',
    project_id: process.env.FIREBASE_PROJECT_ID
  });
});

// ปรับปรุง Debug endpoint ให้ตรวจสอบ collection ที่ถูกต้อง
app.get('/debug', async (req, res) => {
  try {
    // ตรวจสอบ preferences collection
    const preferencesSnapshot = await db.collection('preferences').limit(5).get();
    const preferencesDocs = [];
    preferencesSnapshot.forEach(doc => {
      preferencesDocs.push({ id: doc.id, data: doc.data() });
    });
    
    // ตรวจสอบ book_type document
    const bookTypeDoc = await db.collection('preferences').doc('book_type').get();
    const bookTypeData = bookTypeDoc.exists ? bookTypeDoc.data() : null;
    
    // ตรวจสอบ audio_content collection
    const audioSnapshot = await db.collection('audio_content').limit(5).get();
    const audioDocs = [];
    audioSnapshot.forEach(doc => {
      audioDocs.push({ id: doc.id, data: doc.data() });
    });
    
    res.json({
      status: 'OK',
      firestore_connection: 'success',
      project_id: process.env.FIREBASE_PROJECT_ID,
      collections: {
        preferences: {
          size: preferencesSnapshot.size,
          sample_docs: preferencesDocs
        },
        book_type_document: bookTypeData,
        audio_content: {
          size: audioSnapshot.size,
          sample_docs: audioDocs
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      firestore_connection: 'failed',
      project_id: process.env.FIREBASE_PROJECT_ID,
      error: error.message
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('🚀 Server running on port', port);
  console.log('📍 Health check:', `http://localhost:${port}/health`);
  console.log('🔍 Debug endpoint:', `http://localhost:${port}/debug`);
});
