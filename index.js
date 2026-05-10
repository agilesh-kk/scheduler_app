const admin = require("firebase-admin");
const express = require("express");
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

async function addRow(data) {
  const { error } = await supabase
    .from('messages')   // your table name
    .insert([
      {
        name: data.name || 'unknown',
        sender_Id: data.senderId,
        receiver_Id: data.receiverId,
        chat_Id: data.convoId,
        text: data.type=='text' ? data.content : data.type
      }
    ])
    .select();

  if (error) {
    console.error('Insert failed:', error);
    return;
  }
}

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
    const timelineQueue = [];

    for (const doc of snapshot.docs) {

      const data = doc.data();

      if (data.status !== "scheduled") continue;

      const convoRef = doc.ref.parent.parent;
      if (!convoRef) continue;

      // =====================================================
      // 🔴 1. DELETE FOR EVERYONE (HARD DELETE)
      // =====================================================
      if (data.deletedForEveryone === true) {
        batch.delete(doc.ref); // ❌ remove completely
        console.log("🗑 Deleted scheduled (everyone):", doc.id);
        continue;
      }

      // =====================================================
      // 🔵 2. DELETE FOR ME (SENDER ONLY)
      // =====================================================
      // if (data.deletedfor && data.deletedfor.includes(data.senderId)) {
      //   batch.delete(doc.ref); // ❌ sender removed → don't send
      //   console.log("👤 Deleted scheduled (for me):", doc.id);
      //   continue;
      // }

      // =====================================================
      // ✅ 3. NORMAL SEND FLOW
      // =====================================================
      const convoSnap = await convoRef.get();
      const convoData = convoSnap.data();

      if (!convoData || !convoData.participantsId) continue;

      const participants = convoData.participantsId;
      const senderId = data.senderId;
      const receiverId = participants.find(id => id !== senderId);

      if (!receiverId) continue;

      const messageRef = convoRef.collection("messages").doc(doc.id);

      // 🔥 Move to messages
      batch.set(messageRef, {
        senderId: data.senderId,
        content: data.content,
        type: data.type || "text",
        status: "sent",
        isScheduled: false,
        isFromScheduler: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),

        // 🔥 IMPORTANT (DO NOT REMOVE)
        deletedfor: data.deletedfor || [],
        deletedForEveryone: data.deletedForEveryone || false,
      });

      // ❌ Remove scheduled
      batch.delete(doc.ref);

      const content =
        data.type === "text" ? data.content : "📷Image";

      const serverTime =
        admin.firestore.FieldValue.serverTimestamp();

      const isDeletedForSender =
        data.deletedfor && data.deletedfor.includes(senderId);
      // 🔥 Conversation update
      batch.update(convoRef, {
        lastupdateTime: serverTime,

        // 🔵 Sender (ONLY if visible)
        ...(isDeletedForSender
          ? {} // ❌ don't update sender view
          : {
              [`${senderId}.lastMessage`]: content,
              [`${senderId}.lastMessageId`]: doc.id,
              [`${senderId}.lastSender`]: senderId,
              [`${senderId}.lastupdateTime`]: serverTime,
            }),

        [`${senderId}.unread`]: 0,

        // 🔴 Receiver
        [`${receiverId}.lastMessage`]: content,
        [`${receiverId}.lastMessageId`]: doc.id,
        [`${receiverId}.lastSender`]: senderId,
        [`${receiverId}.lastupdateTime`]: serverTime,
        [`${receiverId}.unread`]:
          admin.firestore.FieldValue.increment(1),
      });

      timelineQueue.push({
        messageId: doc.id,
        senderId,
        receiverId,
        type: data.type || "text",
        content: data.content,
      });

      console.log("✅ Sent:", doc.id);
    }

    await batch.commit();
    addRow(data);
    console.log("🎉 Batch committed successfully");

    // 🔥 PROCESS TIMELINE AFTER COMMIT
    await Promise.all(
      timelineQueue.map((msg) => processTimelineEvent(msg))
    );

    console.log("📌 Timeline updated");

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

async function processTimelineEvent(message) {
  const { messageId, senderId, receiverId, type, content } = message;

  const convoId = [senderId, receiverId].sort().join("_");
  const convoRef = db.collection("Conversations").doc(convoId);

  const statsRef = convoRef.collection("rule_counters").doc("counters");

  let created = false;

  await db.runTransaction(async (transaction) => {
    const statsSnap = await transaction.get(statsRef);

    let totalMessages = 0;

    if (statsSnap.exists) {
      totalMessages = statsSnap.data().totalMessages || 0;
    }

    totalMessages += 1;

    transaction.set(statsRef, {
      totalMessages
    }, { merge: true });

    // 🔥 SIMPLE MILESTONES
    const milestones = [50, 100, 500, 1000, 2000, 5000];

    if (!milestones.includes(totalMessages)) return;

    const eventId = `${convoId}_${totalMessages}`;

    const timelineRef = convoRef.collection("timeline").doc(eventId);

    created = true;

    transaction.set(timelineRef, {
      id: eventId,
      title: "Milestone 🎯",
      content: `Reached ${totalMessages} messages`,
      type,
      time: admin.firestore.FieldValue.serverTimestamp(),
      index: totalMessages,
      messageId: messageId,
    });
  });

  if (created) {
    await db.collection("Conversations")
      .doc(convoId)
      .collection("messages")
      .doc(messageId)
      .set({ inTimeline: true }, { merge: true });
  }
}

// 🚀 START
startScheduler();
