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

// 🔥 IMPORTANT: Use dynamic port (Render requirement)
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

// 🚀 Scheduler starts
console.log("🚀 Scheduler started...");

// 🔁 Run every 1 minute
setInterval(async () => {
  try {
    const now = admin.firestore.Timestamp.now();
    console.log("⏱ Checking at:", new Date());

    // 🔥 OPTIMIZED QUERY (no full collection scan)
    const snapshot = await db
      .collectionGroup("scheduled_messages")
      .where("sendAt", "<=", now)
      .where("status", "==", "scheduled")
      .get();

    if (snapshot.empty) {
      console.log("📭 No scheduled messages to process");
      return;
    }

    console.log(`📦 Found ${snapshot.size} messages`);

    const batch = db.batch();

    for (const doc of snapshot.docs) {
      const data = doc.data();

      // 🔒 Safety check
      if (data.status !== "scheduled") continue;

      // 🔥 Get parent conversation
      const convoRef = doc.ref.parent.parent;

      if (!convoRef) continue;

      const messageRef = convoRef.collection("messages").doc(doc.id);
      
      // 🎯 Get sender and receiver IDs
      const senderId = data.senderId;
      const receiverId = data.receiverId;

      // ✅ Move to messages
      batch.set(messageRef, {
        ...data,
        status: "sent",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ❌ Remove from scheduled
      batch.delete(doc.ref);

      // 🔥 Update conversation preview AND mark receiver as unread
      batch.set(
        convoRef,
        {
          lastMessage: data.content,
          lastupdateTime: admin.firestore.FieldValue.serverTimestamp(),
          // 🔔 IMPORTANT: Mark receiver as not seen (shows notification badge)
          [receiverId]: {
            lastSeen: false,
            lastSeenTime: admin.firestore.FieldValue.serverTimestamp(),
          }
        },
        { merge: true }
      );

      console.log("✅ Sent message:", doc.id, "to:", receiverId);
    }

    // 🚀 Commit once for all messages
    await batch.commit();

    console.log("🎉 Batch committed successfully");
  } catch (e) {
    console.error("❌ Scheduler Error:", e);
  }
}, 60000); // every 1 min