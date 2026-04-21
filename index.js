const admin = require("firebase-admin");
const express = require("express");

// 🔐 Firebase init
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// 🌐 Express (Render keep-alive)
const app = express();

app.get("/", (req, res) => {
  res.send("Scheduler is running 🚀");
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

console.log("🚀 Scheduler starting...");

// 🔥 MAIN SCHEDULER FUNCTION
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

      // ✅ Safety
      if (data.status !== "scheduled") continue;

      // ❌ Skip if sender deleted it before sending
      if (data.deletedfor && data.deletedfor.includes(data.senderId)) {
        console.log("⛔ Skipping deleted scheduled message:", doc.id);
        continue;
      }

      const convoRef = doc.ref.parent.parent;
      if (!convoRef) continue;

      const convoSnap = await convoRef.get();
      const convoData = convoSnap.data();

      if (!convoData || !convoData.participantsId) continue;

      const participants = convoData.participantsId;
      const senderId = data.senderId;

      const receiverId = participants.find(id => id !== senderId);

      if (!receiverId) {
        console.log("❌ receiverId not found:", doc.id);
        continue;
      }

      if (!convoData[senderId] || !convoData[receiverId]) {
        console.log("❌ user data missing in convo:", doc.id);
        continue;
      }

      const messageRef =
        convoRef.collection("messages").doc(doc.id);

      // =====================================================
      // ✅ MOVE MESSAGE → messages collection
      // =====================================================
      batch.set(messageRef, {
        ...data,
        status: "sent",
        isScheduled: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ❌ DELETE scheduled message
      batch.delete(doc.ref);

      const content =
        data.type === "text" ? data.content : "📷Image";

      const serverTime =
        admin.firestore.FieldValue.serverTimestamp();

      // =====================================================
      // ✅ PER-USER CONVERSATION UPDATE
      // =====================================================
      batch.update(convoRef, {
        // 🔥 ROOT (for sorting)
        lastupdateTime: admin.firestore.FieldValue.serverTimestamp(),
        // 🔵 Sender view
        [`${senderId}.lastMessage`]: content,
        [`${senderId}.lastMessageId`]: doc.id,
        [`${senderId}.lastSender`]: senderId,
        [`${senderId}.lastupdateTime`]: serverTime,
        [`${senderId}.unread`]: 0,

        // 🔴 Receiver view
        [`${receiverId}.lastMessage`]: content,
        [`${receiverId}.lastMessageId`]: doc.id,
        [`${receiverId}.lastSender`]: senderId,
        [`${receiverId}.lastupdateTime`]: serverTime,
        [`${receiverId}.unread`]:
          admin.firestore.FieldValue.increment(1),
      });

      console.log("✅ Sent:", doc.id, "→", receiverId);
    }

    await batch.commit();
    console.log("🎉 Batch committed successfully");

  } catch (e) {
    console.error("❌ Scheduler Error:", e);
  }
}

// 🔥 ALIGN TO EXACT MINUTE
function startScheduler() {
  const now = new Date();

  const delay =
    60000 - (now.getSeconds() * 1000 + now.getMilliseconds());

  console.log("⏳ Aligning scheduler in", delay, "ms");

  setTimeout(() => {
    runScheduler();
    setInterval(runScheduler, 60000);
  }, delay);
}

// 🚀 START
startScheduler();