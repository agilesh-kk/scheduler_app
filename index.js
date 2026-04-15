const admin = require("firebase-admin");
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

console.log("🚀 Scheduler started...");

setInterval(async () => {
  try {
    const now = admin.firestore.Timestamp.now();
    console.log("⏱ Checking at:", new Date());

    const conversations = await db.collection("Conversations").get();

    for (const convo of conversations.docs) {
      const convoRef = convo.ref;

      const scheduledMessages = await convoRef
        .collection("scheduled_messages")
        .where("sendAt", "<=", now)
        .where("status", "==", "scheduled")
        .get();

      if (scheduledMessages.empty) continue;

      const batch = db.batch();

      for (const doc of scheduledMessages.docs) {
        const data = doc.data();

        if (data.status !== "scheduled") continue; // safety

        // 🔥 Move to messages
        const messageRef = convoRef.collection("messages").doc(doc.id);

        batch.set(messageRef, {
          ...data,
          status: "sent",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // ❌ Remove scheduled
        batch.delete(doc.ref);

        // 🔥 Update conversation preview
        batch.set(convoRef, {
          lastMessage: data.content,
          lastupdateTime: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      await batch.commit();
    }

  } catch (e) {
    console.error("❌ Error:", e);
  }
}, 60000); // every 1 min