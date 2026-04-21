const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");

admin.initializeApp();

// TODO: Replace with the actual Gemini API key provided by the user
const apiKey = "YOUR_GEMINI_API_KEY_HERE";
const genAI = new GoogleGenerativeAI(apiKey);

exports.autoReplyGuestbook = onSchedule({
    schedule: "0 9 * * *",
    timeZone: "Asia/Seoul"
}, async (event) => {
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
