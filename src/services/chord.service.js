function redactSecrets(value, apiKey = "") {
  if (Array.isArray(value)) return value.map(entry => redactSecrets(entry, apiKey));
  if (typeof value === "string") return apiKey ? value.split(apiKey).join("[REDACTED]") : value;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/authorization|api.?key|secret|token|password|credential/i.test(key)) return [key, "[REDACTED]"];
    return [key, redactSecrets(entry, apiKey)];
  }));
}

async function sendNotification(eventType, orderRef, details = {}) {
  const baseUrl = (process.env.CHORD_BASE_URL).replace(/\/+$/, "");
  const apiKey = process.env.CHORD_API_KEY;
  const workspaceId = process.env.CHORD_WORKSPACE_ID;
  const teammateId = process.env.CHORD_TEAMMATE_ID;
  const conversationId = process.env.CHORD_CONVERSATION_ID;
  const missing = [
    ["CHORD_API_KEY", apiKey],
    ["CHORD_WORKSPACE_ID", workspaceId],
    ["CHORD_TEAMMATE_ID", teammateId],
    ["CHORD_CONVERSATION_ID", conversationId],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    console.error("Chord notification not sent: required configuration is missing", { eventType, missing });
    throw new Error("Chord notification configuration is incomplete.");
  }

  const scheduledAt = new Date(Date.now() + 60_000).toISOString();
  const endpoint = `${baseUrl}/v1/scheduled-tasks`;
  const body = {
    task_type: "MESSAGE",
    scheduled_at: scheduledAt,
    workspace_id: workspaceId,
    teammate_id: teammateId,
    payload: {
      platform: "DIRECT_LINE",
      conversation_id: conversationId,
      body: eventType === "low_inventory"
        ? `Low inventory alert: ${details.name || orderRef} has ${details.stock} available; threshold is ${details.threshold}.`
        : eventType === "payment_confirmed"
        ? `Payment confirmed for pharmacy order ${orderRef}.`
        : `Your pharmacy order ${orderRef} is ready for pickup.`,
    },
  };

  console.info("Sending Chord notification", { eventType, orderRef, endpoint: "/v1/scheduled-tasks", scheduledAt });
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error("Chord notification request failed", {
      eventType,
      errorType: error?.name || "NetworkError",
    });
    throw new Error("Chord notification request failed.");
  }

  const result = await response.json().catch(() => null);
  const taskId = result?.id || result?.task_id || null;
  if (!response.ok || !taskId || !result?.status) {
    console.error("Chord notification response", {
      eventType,
      httpStatus: response.status,
      taskId,
      taskStatus: result?.status || null,
      errorBody: redactSecrets(result, apiKey),
    });
    throw new Error(response.ok
      ? "Chord notification response did not include a task id and status."
      : `Chord notification request returned HTTP ${response.status}.`);
  }

  console.info("Chord notification response", {
    eventType,
    httpStatus: response.status,
    taskId,
    taskStatus: result?.status || null,
  });
  return { sent: true, taskId, status: result?.status || null };
}

module.exports = { sendNotification };
