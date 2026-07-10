const admin = require('firebase-admin');

// We need a credential. Usually if we run this locally, we can export GOOGLE_APPLICATION_CREDENTIALS
// But let's just initializeApp without args if they have it configured.
admin.initializeApp({
    projectId: "forrest-stay"
});

async function fixRecords() {
    const db = admin.firestore();
    const snapshot = await db.collection('guestbook').get();
    let count = 0;
    let oldTimestamp = new Date('2024-01-01T00:00:00Z').getTime();

    const batch = db.batch();
    snapshot.forEach(doc => {
        const data = doc.data();
        if (!data.createdAt) {
            oldTimestamp += 1000; // Increment to keep them ordered
            batch.update(doc.ref, {
                createdAt: admin.firestore.Timestamp.fromMillis(oldTimestamp)
            });
            count++;
            console.log(`Added createdAt to document: ${doc.id}`);
        }
    });

    if (count > 0) {
        await batch.commit();
        console.log(`Updated ${count} records.`);
    } else {
        console.log('No records needed updating.');
    }
}

fixRecords().catch(console.error);
