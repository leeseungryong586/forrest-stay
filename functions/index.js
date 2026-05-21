const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const bcrypt = require("bcryptjs");

admin.initializeApp();

const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD || "admin1234";

exports.autoReplyGuestbook = onSchedule({
    schedule: "0 9 * * *",
    timeZone: "Asia/Seoul"
}, async (event) => {
    if (!genAI) return;
    console.log("Starting daily 9 AM AI auto-reply execution.");

    const db = admin.firestore();
    const guestbookRef = db.collection('guestbook');

    const snapshot = await guestbookRef.where('reply', '==', null).get();

    if (snapshot.empty) {
        console.log('No new guestbook entries to reply to.');
        return;
    }

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const batch = db.batch();

    for (const doc of snapshot.docs) {
        const data = doc.data();

        const prompt = `당신은 영종도의 자연 속 쉼터, 'FOR.REST STAY'의 다정하고 감성적인 호스트입니다.
아래는 게스트가 두고 간 방명록 메시지입니다.

방문자: ${data.name}
남긴 글: "${data.message}"

이 글을 남긴 분에게 따뜻한 위로와 쉼에 대한 여운이 남는 2~3문장 길이의 답글을 작성해 주세요.`;

        try {
            const result = await model.generateContent(prompt);
            const response = result.response.text();

            batch.update(doc.ref, { reply: response });
            console.log(`Generated reply for ${data.name}.`);
        } catch (err) {
            console.error(`Error generating reply for ${doc.id}:`, err);
        }
    }

    await batch.commit();
    console.log("Successfully generated and saved all replies.");
});

// Helper for Rate Limiting
async function checkRateLimit(ip) {
    const db = admin.firestore();
    const rateLimitRef = db.collection('settings').doc(`rateLimit_${ip}`);
    const doc = await rateLimitRef.get();
    const now = Date.now();

    if (doc.exists) {
        const data = doc.data();
        if (data.fails >= 5 && now - data.lastFail < 60000) {
            throw new HttpsError('resource-exhausted', '너무 많은 시도가 있었습니다. 1분 후 다시 시도해주세요.');
        }
    }
}

async function recordFail(ip) {
    const db = admin.firestore();
    const rateLimitRef = db.collection('settings').doc(`rateLimit_${ip}`);
    const doc = await rateLimitRef.get();
    const now = Date.now();

    if (doc.exists) {
        const data = doc.data();
        if (now - data.lastFail > 60000) {
            await rateLimitRef.set({ fails: 1, lastFail: now });
        } else {
            await rateLimitRef.update({ fails: admin.firestore.FieldValue.increment(1), lastFail: now });
        }
    } else {
        await rateLimitRef.set({ fails: 1, lastFail: now });
    }
}

async function resetFail(ip) {
    const db = admin.firestore();
    const rateLimitRef = db.collection('settings').doc(`rateLimit_${ip}`);
    await rateLimitRef.delete();
}

exports.adminLogin = onCall(async (request) => {
    const password = request.data.password;
    const ip = request.rawRequest.ip || "unknown";

    if (!password) {
        throw new HttpsError('invalid-argument', '비밀번호를 입력해주세요.');
    }

    await checkRateLimit(ip);

    const db = admin.firestore();
    const adminDocRef = db.collection('settings').doc('adminAuth');
    const doc = await adminDocRef.get();

    let isFirstLogin = false;
    let isValid = false;

    if (!doc.exists || !doc.data().hashedPassword) {
        // 최초 로그인
        if (password === INITIAL_ADMIN_PASSWORD) {
            isValid = true;
            isFirstLogin = true;
        }
    } else {
        const data = doc.data();
        isValid = await bcrypt.compare(password, data.hashedPassword);
        isFirstLogin = data.isFirstLogin === true;
    }

    if (!isValid) {
        await recordFail(ip);
        throw new HttpsError('permission-denied', '비밀번호가 일치하지 않습니다.');
    }

    await resetFail(ip);

    if (isFirstLogin) {
        return { isFirstLogin: true, token: null };
    }

    // 성공 시 Custom Token 발급
    try {
        const customToken = await admin.auth().createCustomToken("admin-user", { admin: true });
        return { isFirstLogin: false, token: customToken };
    } catch (error) {
        console.error("Error creating custom token:", error);
        throw new HttpsError('internal', '토큰 발급에 실패했습니다.');
    }
});

exports.changeAdminPassword = onCall(async (request) => {
    const oldPassword = request.data.oldPassword;
    const newPassword = request.data.newPassword;
    const ip = request.rawRequest.ip || "unknown";

    if (!oldPassword || !newPassword) {
        throw new HttpsError('invalid-argument', '기존 비밀번호와 새 비밀번호를 모두 입력해주세요.');
    }

    await checkRateLimit(ip);

    const db = admin.firestore();
    const adminDocRef = db.collection('settings').doc('adminAuth');
    const doc = await adminDocRef.get();

    let isValid = false;

    if (!doc.exists || !doc.data().hashedPassword) {
        if (oldPassword === INITIAL_ADMIN_PASSWORD) {
            isValid = true;
        }
    } else {
        const data = doc.data();
        isValid = await bcrypt.compare(oldPassword, data.hashedPassword);
    }

    if (!isValid) {
        await recordFail(ip);
        throw new HttpsError('permission-denied', '기존 비밀번호가 일치하지 않습니다.');
    }

    await resetFail(ip);

    // 새 비밀번호 해싱 및 저장
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await adminDocRef.set({
        hashedPassword: hashedPassword,
        isFirstLogin: false
    });

    try {
        const customToken = await admin.auth().createCustomToken("admin-user", { admin: true });
        return { success: true, token: customToken };
    } catch (error) {
        console.error("Error creating custom token:", error);
        throw new HttpsError('internal', '비밀번호는 변경되었으나 토큰 발급에 실패했습니다.');
    }
});

exports.deleteGuestbookEntry = onCall(async (request) => {
    const entryId = request.data.entryId;
    const userPassword = request.data.password; // 사용자용 비밀번호
    const isAdmin = request.auth && request.auth.token.admin === true;

    if (!entryId) {
        throw new HttpsError('invalid-argument', '삭제할 항목의 ID가 필요합니다.');
    }

    const db = admin.firestore();
    const entryRef = db.collection('guestbook').doc(entryId);
    const doc = await entryRef.get();

    if (!doc.exists) {
        throw new HttpsError('not-found', '해당 항목을 찾을 수 없습니다.');
    }

    const data = doc.data();

    // 권한 체크
    if (!isAdmin) {
        if (!userPassword || !data.password) {
            throw new HttpsError('permission-denied', '삭제 권한이 없습니다.');
        }
        
        // 간단한 평문 또는 클라이언트에서 해시된 값 대조. 
        // 보안을 위해 프론트엔드에서 SHA-256 해싱된 값을 저장/전송한다고 가정
        if (data.password !== userPassword) {
            throw new HttpsError('permission-denied', '비밀번호가 일치하지 않습니다.');
        }
    }

    // Firestore에서 항목 삭제
    await entryRef.delete();

    // Storage 파일 삭제 로직은 클라이언트에서 수행해도 되지만, 
    // Admin 권한으로 Functions에서 삭제하는 것이 더 안전함.
    const bucket = admin.storage().bucket();
    
    try {
        if (data.audioUrl) {
            // URL에서 경로 추출 시도
            const audioPath = decodeURIComponent(data.audioUrl.split('/o/')[1].split('?')[0]);
            await bucket.file(audioPath).delete();
        }
    } catch (err) {
        console.log('오디오 삭제 실패 또는 파일 없음', err);
    }

    try {
        if (data.photoUrls && Array.isArray(data.photoUrls)) {
            for (const url of data.photoUrls) {
                const photoPath = decodeURIComponent(url.split('/o/')[1].split('?')[0]);
                await bucket.file(photoPath).delete();
            }
        }
    } catch (err) {
        console.log('사진 삭제 실패 또는 파일 없음', err);
    }

    return { success: true };
});
