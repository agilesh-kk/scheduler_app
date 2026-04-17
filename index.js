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

      if (data.status !== "scheduled") continue;

      const convoRef = doc.ref.parent.parent;
      if (!convoRef) continue;

      const convoSnap = await convoRef.get();
      const convoData = convoSnap.data();

      if (!convoData || !convoData.participantsId) continue;

      const participants = convoData.participantsId;
      const senderId = data.senderId;

      // 🔥 SAFE RECEIVER DETECTION
      let receiverId = null;

      for (const id of participants) {
        if (id !== senderId) {
          receiverId = id;
          break;
        }
      }

      // 🚨 SAFETY CHECKS
      if (!receiverId) {
        console.log("❌ receiverId not found");
        continue;
      }

      if (!convoData[receiverId] || !convoData[senderId]) {
        console.log("❌ participant data missing");
        continue;
      }

      const messageRef = convoRef.collection("messages").doc(doc.id);

      // ✅ Move message
      batch.set(messageRef, {
        ...data,
        status: "sent",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ❌ Delete scheduled
      batch.delete(doc.ref);

      // 🔥 CORRECT UNREAD UPDATE (NO DOT NOTATION)
      const receiverData = convoData[receiverId];
      const senderData = convoData[senderId];

      batch.update(convoRef, {
        lastMessage: data.content,
        lastupdateTime: admin.firestore.FieldValue.serverTimestamp(),

        [receiverId]: {
          ...receiverData,
          unread: (receiverData.unread || 0) + 1,
        },

        [senderId]: {
          ...senderData,
          unread: 0,
        },
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