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

      // ✅ Extra safety
      if (data.status !== "scheduled") continue;

      // ❌ Skip if user deleted before sending
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

      // ✅ Cleaner receiver detection
      const receiverId = participants.find(id => id !== senderId);

      if (!receiverId) {
        console.log("❌ receiverId not found for:", doc.id);
        continue;
      }

      if (!convoData[receiverId] || !convoData[senderId]) {
        console.log("❌ participant data missing for:", doc.id);
        continue;
      }

      const messageRef = convoRef.collection("messages").doc(doc.id);

      // ✅ Move message → messages collection
      batch.set(messageRef, {
        ...data,
        status: "sent",
        isScheduled: false, // 🔥 FIX
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ❌ Delete from scheduled_messages
      batch.delete(doc.ref);

      // ✅ Update conversation (WhatsApp-like)
      batch.update(convoRef, {
        lastMessage:
          data.type === "text" ? data.content : "📷Image",

        lastMessageId: doc.id, // 🔥 IMPORTANT
        lastSender: senderId,  // 🔥 IMPORTANT

        lastupdateTime:
          admin.firestore.FieldValue.serverTimestamp(),

        // 🔔 Unread updates
        [`${receiverId}.unread`]:
          admin.firestore.FieldValue.increment(1),

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