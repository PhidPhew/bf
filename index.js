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
let db;
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}-default-rtdb.asia-southeast1.firebasedatabase.app/`
  });
  db = admin.firestore();
  console.log('✅ Firebase initialized successfully');
} catch (error) {
  console.error('❌ Firebase initialization error:', error.message);
  console.error('Full error:', error);
  process.exit(1);
}

// Test Firestore connection
async function testFirestoreConnection() {
  try {
    console.log('🔍 Testing Firestore connection...');
    
    const preferencesSnapshot = await db.collection('preferences').get();
    console.log('📄 Documents in preferences collection:', preferencesSnapshot.size);
    
    const docNames = [];
    preferencesSnapshot.forEach(doc => {
      docNames.push(doc.id);
    });
    console.log('📋 Document names:', docNames);
    
    console.log('✅ Firestore connection successful');
    
  } catch (error) {
    console.error('❌ Firestore connection failed:', error.message);
    console.error('Error code:', error.code);
  }
}

// Initialize connection test (non-blocking)
setTimeout(() => {
  testFirestoreConnection();
}, 1000);

// ฟังก์ชันสำหรับตรวจจับชื่อคนในคำถาม
function detectPersonInQuestion(question) {
  if (!question || typeof question !== 'string') {
    return 'both';
  }
  
  const lowerQuestion = question.toLowerCase();
  
  const fernKeywords = ['เฟิร์น', 'fern', 'เฟิ', 'เฟิ่น'];
  const nannamKeywords = ['น่านน้ำ', 'nannam', 'นานาม', 'น่าน', 'นาน'];
  
  const hasFernKeyword = fernKeywords.some(keyword => 
    lowerQuestion.includes(keyword.toLowerCase())
  );
  
  const hasNannamKeyword = nannamKeywords.some(keyword => 
    lowerQuestion.includes(keyword.toLowerCase())
  );
  
  if (hasFernKeyword && !hasNannamKeyword) {
    return 'fern';
  } else if (hasNannamKeyword && !hasFernKeyword) {
    return 'nannam';
  } else {
    return 'both';
  }
}

// ฟังก์ชันสำหรับทำความสะอาดคำถาม
function cleanQuestion(question) {
  if (!question || typeof question !== 'string') {
    return '';
  }
  
  const fernKeywords = ['เฟิร์น', 'fern', 'เฟิ', 'เฟิ่น'];
  const nannamKeywords = ['น่านน้ำ', 'nannam', 'นานาม', 'น่าน', 'นาน'];
  
  let cleanedQuestion = question;
  
  [...fernKeywords, ...nannamKeywords].forEach(name => {
    const regex = new RegExp(name, 'gi');
    cleanedQuestion = cleanedQuestion.replace(regex, '').trim();
  });
  
  cleanedQuestion = cleanedQuestion.replace(/\s+/g, ' ').trim();
  return cleanedQuestion;
}

// ฟังก์ชันใหม่: แยกคำสำคัญจากคำถาม
function extractKeywords(question) {
  if (!question || typeof question !== 'string') {
    return [];
  }
  
  // ลบคำที่ไม่สำคัญ
  const stopWords = [
    'อะไร', 'ไหน', 'เมื่อไหร่', 'ยังไง', 'ทำไม', 'ใคร', 'ไหม', 'หรือ', 'แล้ว',
    'ครับ', 'ค่ะ', 'นะ', 'อ่ะ', 'เอ่อ', 'อืม', 'เออ', 'นะครับ', 'นะคะ',
    'คือ', 'แบบ', 'พอ', 'จัง', 'มาก', 'เลย', 'สุด', 'ได้', 'มั้ย', 'ไง'
  ];
  
  // แยกคำและลบ stop words
  let words = question.split(/\s+/).filter(word => {
    word = word.toLowerCase().replace(/[^\u0E00-\u0E7Fa-zA-Z]/g, '');
    return word.length > 0 && !stopWords.includes(word);
  });
  
  return words;
}

// ฟังก์ชันใหม่: คำนวณความคล้ายคลึงแบบหลายมิติ
function calculateSimilarity(question, data) {
  if (!question || typeof question !== 'string' || !data) {
    return { score: -Infinity, details: [] };
  }
  
  const questionKeywords = extractKeywords(question.toLowerCase());
  console.log('🔍 Question keywords:', questionKeywords);
  
  let bestScore = -Infinity;
  let matchDetails = [];
  
  // 1. ตรวจสอบ exact match ใน question
  if (data.question && typeof data.question === 'string') {
    const exactMatch = questionKeywords.some(keyword => 
      data.question.toLowerCase().includes(keyword)
    );
    if (exactMatch) {
      bestScore = Math.max(bestScore, 1000);
      matchDetails.push('exact_question_match');
    }
    
    // fuzzy match กับ question
    try {
      const fuzzyResult = fuzzysort.single(question, data.question);
      if (fuzzyResult) {
        bestScore = Math.max(bestScore, fuzzyResult.score + 500);
        matchDetails.push(`fuzzy_question: ${fuzzyResult.score}`);
      }
    } catch (error) {
      console.warn('Fuzzy search error:', error.message);
    }
  }
  
  // 2. ตรวจสอบ keywords array
  if (data.keywords && Array.isArray(data.keywords)) {
    data.keywords.forEach((keyword, index) => {
      if (typeof keyword !== 'string') return;
      
      // exact keyword match
      const exactKeywordMatch = questionKeywords.some(qKeyword => 
        keyword.toLowerCase().includes(qKeyword) || qKeyword.includes(keyword.toLowerCase())
      );
      
      if (exactKeywordMatch) {
        bestScore = Math.max(bestScore, 800);
        matchDetails.push(`exact_keyword[${index}]: ${keyword}`);
      }
      
      // fuzzy keyword match
      try {
        const fuzzyKeywordResult = fuzzysort.single(question, keyword);
        if (fuzzyKeywordResult && fuzzyKeywordResult.score > -2000) {
          bestScore = Math.max(bestScore, fuzzyKeywordResult.score + 300);
          matchDetails.push(`fuzzy_keyword[${index}]: ${fuzzyKeywordResult.score}`);
        }
      } catch (error) {
        console.warn('Fuzzy keyword search error:', error.message);
      }
      
      // partial keyword match
      questionKeywords.forEach(qKeyword => {
        if (qKeyword.length > 2 && keyword.toLowerCase().includes(qKeyword)) {
          bestScore = Math.max(bestScore, 600);
          matchDetails.push(`partial_keyword[${index}]: ${qKeyword} in ${keyword}`);
        }
      });
    });
  }
  
  // 3. ตรวจสอบความคล้ายคลึงของคำแต่ละคำ
  questionKeywords.forEach(qKeyword => {
    if (data.question && typeof data.question === 'string') {
      const questionWords = extractKeywords(data.question);
      questionWords.forEach(dataWord => {
        if (qKeyword.length > 2 && dataWord.length > 2) {
          // เช็ค substring match
          if (qKeyword.includes(dataWord) || dataWord.includes(qKeyword)) {
            bestScore = Math.max(bestScore, 400);
            matchDetails.push(`word_similarity: ${qKeyword} ~ ${dataWord}`);
          }
          
          // เช็ค edit distance (simple)
          if (Math.abs(qKeyword.length - dataWord.length) <= 2) {
            let commonChars = 0;
            for (let i = 0; i < Math.min(qKeyword.length, dataWord.length); i++) {
              if (qKeyword[i] === dataWord[i]) commonChars++;
            }
            if (commonChars >= Math.min(qKeyword.length, dataWord.length) * 0.6) {
              bestScore = Math.max(bestScore, 300);
              matchDetails.push(`char_similarity: ${qKeyword} ~ ${dataWord}`);
            }
          }
        }
      });
    }
  });
  
  return { score: bestScore, details: matchDetails };
}

// ปรับปรุง findAnswer ให้ใช้ระบบใหม่
async function findAnswer(originalQuestion) {
  try {
    if (!originalQuestion || typeof originalQuestion !== 'string') {
      return 'กรุณาส่งคำถามเป็นข้อความครับ 🙏';
    }
    
    console.log('🔍 Original question:', originalQuestion);
    
    const targetPerson = detectPersonInQuestion(originalQuestion);
    console.log('👤 Target person detected:', targetPerson);
    
    const cleanedQuestion = cleanQuestion(originalQuestion);
    console.log('🧹 Cleaned question:', cleanedQuestion);
    
    const searchQuestion = cleanedQuestion || originalQuestion;
    
    if (!db) {
      console.error('❌ Database not initialized');
      return 'เกิดข้อผิดพลาดในการเชื่อมต่อฐานข้อมูล กรุณาลองใหม่อีกครั้ง 🙏';
    }
    
    const preferencesSnapshot = await db.collection('preferences').get();
    
    if (preferencesSnapshot.empty) {
      console.log('📭 No documents found in preferences collection');
      return 'ขออภัยครับ ยังไม่มีข้อมูลในระบบ';
    }

    console.log('📄 Documents in preferences collection:', preferencesSnapshot.size);

    let bestMatch = null;
    let bestScore = -Infinity;
    let bestDocId = '';
    let allMatches = [];

    // วนลูปค้นหาด้วยระบบใหม่
    preferencesSnapshot.forEach(doc => {
      try {
        const data = doc.data();
        const docId = doc.id;
        
        console.log(`\n🔍 Checking document: ${docId}`);
        
        const similarity = calculateSimilarity(searchQuestion, data);
        
        console.log(`📊 Similarity score: ${similarity.score}`);
        console.log(`📝 Match details:`, similarity.details);
        
        allMatches.push({
          docId,
          data,
          score: similarity.score,
          details: similarity.details
        });
        
        if (similarity.score > bestScore) {
          bestScore = similarity.score;
          bestMatch = data;
          bestDocId = docId;
          console.log(`📈 New best match: ${docId} (score: ${similarity.score})`);
        }
      } catch (docError) {
        console.error(`❌ Error processing document ${doc.id}:`, docError.message);
      }
    });

    // เรียงลำดับและแสดง top matches
    allMatches.sort((a, b) => b.score - a.score);
    console.log('\n🏆 Top 3 matches:');
    allMatches.slice(0, 3).forEach((match, index) => {
      console.log(`${index + 1}. ${match.docId}: ${match.score} - ${match.details.join(', ')}`);
    });

    console.log(`\n🎯 Final best match score: ${bestScore}`);
    console.log('📄 Best match from document:', bestDocId);

    // ลด threshold ให้ต่ำลง เพื่อให้ตอบได้มากขึ้น
    if (bestMatch && bestScore > -1000) {
      let selectedAnswer = '';
      
      if (targetPerson === 'fern' && bestMatch.fern_answer) {
        selectedAnswer = bestMatch.fern_answer;
      } else if (targetPerson === 'nannam' && bestMatch.nannam_answer) {
        selectedAnswer = bestMatch.nannam_answer;
      } else if (targetPerson === 'both') {
        const answers = [];
        if (bestMatch.fern_answer) answers.push(bestMatch.fern_answer);
        if (bestMatch.nannam_answer) answers.push(bestMatch.nannam_answer);
        
        if (answers.length === 2) {
          selectedAnswer = answers.join('\n\n');
        } else if (answers.length === 1) {
          selectedAnswer = answers[0];
        }
      }
      
      // ถ้าไม่มีคำตอบที่เหมาะสม ลองหาทางเลือกอื่น
      if (!selectedAnswer) {
        const fallbackAnswers = [];
        if (bestMatch.fern_answer) fallbackAnswers.push(bestMatch.fern_answer);
        if (bestMatch.nannam_answer) fallbackAnswers.push(bestMatch.nannam_answer);
        
        if (fallbackAnswers.length > 0) {
          if (targetPerson === 'fern') {
            selectedAnswer = `ขออภัยครับ ไม่มีข้อมูลของเฟิร์นสำหรับคำถามนี้ 😅\nแต่มีข้อมูลใกล้เคียง: ${fallbackAnswers[0]}`;
          } else if (targetPerson === 'nannam') {
            selectedAnswer = `ขออภัยครับ ไม่มีข้อมูลของน่านน้ำสำหรับคำถามนี้ 😅\nแต่มีข้อมูลใกล้เคียง: ${fallbackAnswers[fallbackAnswers.length - 1]}`;
          } else {
            selectedAnswer = fallbackAnswers[Math.floor(Math.random() * fallbackAnswers.length)];
          }
        }
      }
      
      if (selectedAnswer) {
        console.log('✅ Answer found:', selectedAnswer.substring(0, 100) + '...');
        return selectedAnswer;
      }
    }

    // ถ้าไม่เจอเลย ให้แสดงคำแนะนำที่ชาญฉลาดขึ้น
    console.log('❌ No matching answer found');
    
    // หาคำถามที่คล้ายที่สุด 3 อันดับแรก
    const suggestions = allMatches
      .filter(match => match.data && match.data.question)
      .slice(0, 3)
      .map(match => `"${match.data.question}"`)
      .join('\n- ');
    
    if (suggestions) {
      return `น้ำยังฟังคำถามไม่ออกอ่าา ลองถามคำถามใหม่ดูนะ:\n- ${suggestions}`;
    } else {
      return 'น้ำยังฟังคำถามไม่ออกอ่าา ลองถามคำถามใหม่ดูนะครับ 🤔';
    }

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

    const userMessage = event.message.text?.trim();
    if (!userMessage) {
      console.log('📝 Empty message received');
      return Promise.resolve(null);
    }
    
    console.log('💬 Received message:', userMessage);
    
    const answer = await findAnswer(userMessage);

    console.log('📤 Sending reply...');
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: answer
    });
  } catch (error) {
    console.error('❌ Error handling event:', error);
    try {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'เกิดข้อผิดพลาดครับ กรุณาลองใหม่อีกครั้ง 🙏'
      });
    } catch (replyError) {
      console.error('❌ Error sending error reply:', replyError);
      return Promise.resolve(null);
    }
  }
}

// Middleware
app.use('/webhook', line.middleware(config));

// Routes
app.get('/', (req, res) => {
  res.send(`
    <h1>Smart LINE Bot is running! 🧠</h1>
    <p>Firebase Status: ✅ Connected</p>
    <p>Project ID: ${process.env.FIREBASE_PROJECT_ID || 'Not Set'}</p>
    <p>Server Time: ${new Date().toISOString()}</p>
    <p>Features: ✅ Advanced AI Matching</p>
  `);
});

app.post('/webhook', (req, res) => {
  if (!req.body || !req.body.events || !Array.isArray(req.body.events)) {
    console.error('❌ Invalid webhook payload');
    return res.status(400).json({ error: 'Invalid payload' });
  }
  
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => {
      console.log('✅ Webhook processed successfully');
      res.json(result);
    })
    .catch((err) => {
      console.error('❌ Webhook error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    firebase: db ? 'connected' : 'disconnected',
    project_id: process.env.FIREBASE_PROJECT_ID || 'Not Set',
    features: ['advanced_similarity', 'smart_matching', 'person_detection']
  });
});

// Debug endpoint
app.get('/debug', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        status: 'ERROR',
        firestore_connection: 'not_initialized',
        project_id: process.env.FIREBASE_PROJECT_ID || 'Not Set',
        error: 'Database not initialized'
      });
    }
    
    const preferencesSnapshot = await db.collection('preferences').limit(5).get();
    const preferencesDocs = [];
    preferencesSnapshot.forEach(doc => {
      preferencesDocs.push({ id: doc.id, data: doc.data() });
    });
    
    res.json({
      status: 'OK',
      firestore_connection: 'success',
      project_id: process.env.FIREBASE_PROJECT_ID || 'Not Set',
      features: {
        advanced_similarity: 'enabled',
        keyword_extraction: 'enabled',
        multi_dimensional_matching: 'enabled',
        smart_suggestions: 'enabled'
      },
      collections: {
        preferences: {
          size: preferencesSnapshot.size,
          sample_docs: preferencesDocs
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      firestore_connection: 'failed',
      project_id: process.env.FIREBASE_PROJECT_ID || 'Not Set',
      error: error.message
    });
  }
});

// เพิ่ม endpoint ทดสอบ similarity
app.get('/test-similarity/:question', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }
    
    const question = decodeURIComponent(req.params.question);
    const person = detectPersonInQuestion(question);
    const cleaned = cleanQuestion(question);
    const keywords = extractKeywords(cleaned || question);
    
    // ทดสอบกับ document แรก
    const preferencesSnapshot = await db.collection('preferences').limit(3).get();
    const testResults = [];
    
    preferencesSnapshot.forEach(doc => {
      const data = doc.data();
      const similarity = calculateSimilarity(cleaned || question, data);
      testResults.push({
        document_id: doc.id,
        score: similarity.score,
        details: similarity.details,
        data_question: data.question,
        data_keywords: data.keywords
      });
    });
    
    res.json({
      original_question: question,
      detected_person: person,
      cleaned_question: cleaned,
      extracted_keywords: keywords,
      test_results: testResults.sort((a, b) => b.score - a.score)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log('🚀 Smart Bot Server running on port', port);
  console.log('📍 Health check:', `http://localhost:${port}/health`);
  console.log('🔍 Debug endpoint:', `http://localhost:${port}/debug`);
  console.log('🧪 Test similarity:', `http://localhost:${port}/test-similarity/[question]`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Process terminated');
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Process terminated');
  });
});

module.exports = app;
