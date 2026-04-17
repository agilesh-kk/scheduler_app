const admin = require("firebase-admin");
const express = require("express");

// 🔐 Load Firebase key from ENV
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// 🌐 Express server (prevents Render timeout)
const app = express();

app.get("/", (req, res) => {
  res.send("Scheduler is running 🚀");
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

// 🚀 Scheduler start
console.log("🚀 Scheduler starting...");

// 🔥 FUNCTION: run scheduler
async function runScheduler() {
  try {
    const now = admin.firestore.Timestamp.now();
    console.log("⏱ Checking at:", new Date());

    const snapshot = await db
      .collectionGroup("scheduled_messages")
      .where("sendAt", "<=", now)
      .where("status", "==", "scheduled")
      .get();

    if (snapshot.empty) {
      console.log("📭 No scheduled messages");
      return;
    }

    console.log(`📦 Found ${snapshot.size} messages`);

    const batch = db.batch();

    for (const doc of snapshot.docs) {
      const data = doc.data();

      if (data.status !== "scheduled") continue;

      const convoRef = doc.ref.parent.parent;
      if (!convoRef) continue;

      // 🔥 Fetch conversation data
      const convoSnap = await convoRef.get();
      const convoData = convoSnap.data();

      const participants = convoData.participantsId;
      const senderId = data.senderId;

      const receiverId = participants.find(id => id !== senderId);

      const messageRef = convoRef.collection("messages").doc(doc.id);

      batch.set(messageRef, {
        ...data,
        status: "sent",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      batch.delete(doc.ref);

      // 🔥 Use update instead of set for nested increment
      batch.update(convoRef, {
        lastMessage: data.content,
        lastupdateTime: admin.firestore.FieldValue.serverTimestamp(),

        // 🔔 Receiver gets unread increment
        [`${receiverId}.unread`]: admin.firestore.FieldValue.increment(1),

        // ✅ Sender unread reset (IMPORTANT)
        [`${senderId}.unread`]: 0,
      });

      console.log("✅ Sent:", doc.id, "→", receiverId);
    }

    await batch.commit();

    console.log("🎉 Batch committed successfully");
  } catch (e) {
    console.error("❌ Scheduler Error:", e);
  }
}

// 🔥 FUNCTION: align to exact minute
function startScheduler() {
  const now = new Date();

  const delay =
    60000 - (now.getSeconds() * 1000 + now.getMilliseconds());

  console.log("⏳ Aligning scheduler in", delay, "ms");

  setTimeout(() => {
    runScheduler(); // first exact run

    setInterval(runScheduler, 60000); // every exact minute
  }, delay);
}

// 🚀 Start aligned scheduler
startScheduler();