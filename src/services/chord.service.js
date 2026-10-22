const WORKSPACE_ID = process.env.CHORD_WORKSPACE_ID;
const TEAMMATE_ID = process.env.CHORD_TEAMMATE_ID;
const API_KEY = process.env.CHORD_API_KEY;

const CONVERSATION_ID = "6ad9bfd74c772d0e6f520272";

async function sendReadyForPickupNotification(orderRef) {
  const scheduledAt = new Date(Date.now() + 60_000).toISOString();

  const response = await fetch(
    "https://api.chordhq.xyz/v1/scheduled-tasks",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task_type: "MESSAGE",
        scheduled_at: scheduledAt,
        workspace_id: WORKSPACE_ID,
        teammate_id: TEAMMATE_ID,
        payload: {
          platform: "DIRECT_LINE",
          conversation_id: CONVERSATION_ID,
          body: `Your pharmacy order ${orderRef} is ready for pickup.`,
        },
      }),
      signal: AbortSignal.timeout(10000),
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(`Chord API ${response.status}: ${JSON.stringify(result)}`);
  }

  return {
    sent: true,
    taskId: result.id,
    status: result.status,
  };
}

module.exports = { sendReadyForPickupNotification };