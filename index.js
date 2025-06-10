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

testFirestoreConnection();

// ฟังก์ชันสำหรับตรวจจับชื่อคนในคำถาม
function detectPersonInQuestion(question) {
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
  const questionKeywords = extractKeywords(question.toLowerCase());
  console.log('🔍 Question keywords:', questionKeywords);
  
  let bestScore = -Infinity;
  let matchDetails = [];
  
  // 1. ตรวจสอบ exact match ใน question
  if (data.question) {
    const exactMatch = questionKeywords.some(keyword => 
      data.question.toLowerCase().includes(keyword)
    );
    if (exactMatch) {
      bestScore = Math.max(bestScore, 1000);
      matchDetails.push('exact_question_match');
    }
    
    // fuzzy match กับ question
    const fuzzyResult = fuzzysort.single(question, data.question);
    if (fuzzyResult) {
      bestScore = Math.max(bestScore, fuzzyResult.score + 500);
      matchDetails.push(`fuzzy_question: ${fuzzyResult.score}`);
    }
  }
  
  // 2. ตรวจสอบ keywords array
  if (data.keywords && Array.isArray(data.keywords)) {
    data.keywords.forEach((keyword, index) => {
      // exact keyword match
      const exactKeywordMatch = questionKeywords.some(qKeyword => 
        keyword.toLowerCase().includes(qKeyword) || qKeyword.includes(keyword.toLowerCase())
      );
      
      if (exactKeywordMatch) {
        bestScore = Math.max(bestScore, 800);
        matchDetails.push(`exact_keyword[${index}]: ${keyword}`);
      }
      
      // fuzzy keyword match
      const fuzzyKeywordResult = fuzzysort.single(question, keyword);
      if (fuzzyKeywordResult && fuzzyKeywordResult.score > -2000) {
        bestScore = Math.max(bestScore, fuzzyKeywordResult.score + 300);
        matchDetails.push(`fuzzy_keyword[${index}]: ${fuzzyKeywordResult.score}`);
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
    if (data.question) {
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
    console.log('🔍 Original question:', originalQuestion);
    
    const targetPerson = detectPersonInQuestion(originalQuestion);
    console.log('👤 Target person detected:', targetPerson);
    
    const cleanedQuestion = cleanQuestion(originalQuestion);
    console.log('🧹 Cleaned question:', cleanedQuestion);
    
    const searchQuestion = cleanedQuestion || originalQuestion;
    
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
    });

    // เรียงลำดับและแสดง top matches
    allMatches.sort((a, b) => b.score - a.score);
    console.log('\n🏆 Top 3 matches:');
    allMatches.slice(0, 3).forEach((match, index) => {
      console.log(`${index + 1}. ${match.docId}: ${match.score} - ${match.details.join(', ')}`);
    });

    console.log(`\n🎯 Final best match score: ${bestScore}`);
    console.log('📄 Best match from document:', bestDocId);

    // --- START: MODIFIED CODE ---
    // ลด threshold ให้ต่ำลง และนำเฉพาะคำตอบมาแสดง
    if (bestMatch && bestScore > -1000) {
      let selectedAnswer = '';
      
      if (targetPerson === 'fern') {
        // ถ้าคำถามเจาะจงถึง "เฟิร์น" ให้ใช้คำตอบของเฟิร์นเท่านั้น
        selectedAnswer = bestMatch.fern_answer || '';
      } else if (targetPerson === 'nannam') {
        // ถ้าคำถามเจาะจงถึง "น่านน้ำ" ให้ใช้คำตอบของน่านน้ำเท่านั้น
        selectedAnswer = bestMatch.nannam_answer || '';
      } else { 
        // กรณีอื่นๆ (เช่น ถามถึงทั้งคู่ หรือไม่ได้เจาะจง) ให้รวมคำตอบที่มี
        const answers = [];
        if (bestMatch.fern_answer) answers.push(bestMatch.fern_answer);
        if (bestMatch.nannam_answer) answers.push(bestMatch.nannam_answer);
        selectedAnswer = answers.join('\n\n');
      }
      
      if (selectedAnswer) {
        console.log('✅ Answer found:', selectedAnswer.substring(0, 100) + '...');
        return selectedAnswer; // คืนค่าเฉพาะคำตอบ
      }
    }

    // ถ้าไม่พบคำตอบ ให้แสดงข้อความใหม่ตามที่ต้องการ
    console.log('❌ No matching answer found');
    
    return `น้ำยังฟังคำถามไม่ออกอ่าา ลองถามคำถามใหม่ดูนะ\n\nเช่น:\n- "เฟิร์นชอบดื่มอะไร"\n- "น่านน้ำชอบอาหารอะไร"`;
    // --- END: MODIFIED CODE ---

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
    <h1>Smart LINE Bot is running! 🧠</h1>
    <p>Firebase Status: ✅ Connected</p>
    <p>Project ID: ${process.env.FIREBASE_PROJECT_ID}</p>
    <p>Server Time: ${new Date().toISOString()}</p>
    <p>Features: ✅ Advanced AI Matching</p>
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
    project_id: process.env.FIREBASE_PROJECT_ID,
    features: ['advanced_similarity', 'smart_matching', 'person_detection']
  });
});

// Debug endpoint
app.get('/debug', async (req, res) => {
  try {
    const preferencesSnapshot = await db.collection('preferences').limit(5).get();
    const preferencesDocs = [];
    preferencesSnapshot.forEach(doc => {
      preferencesDocs.push({ id: doc.id, data: doc.data() });
    });
    
    res.json({
      status: 'OK',
      firestore_connection: 'success',
      project_id: process.env.FIREBASE_PROJECT_ID,
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
      project_id: process.env.FIREBASE_PROJECT_ID,
      error: error.message
    });
  }
});

// เพิ่ม endpoint ทดสอบ similarity
app.get('/test-similarity/:question', async (req, res) => {
  try {
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('🚀 Smart Bot Server running on port', port);
  console.log('📍 Health check:', `http://localhost:${port}/health`);
  console.log('🔍 Debug endpoint:', `http://localhost:${port}/debug`);
  console.log('🧪 Test similarity:', `http://localhost:${port}/test-similarity/[question]`);
});
