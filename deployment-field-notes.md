# Deployment Field Notes — Pharmacy Assistant

**Preferred role:** Forward-Deployed Engineer

## 1. Payment Checkout and Verification

**Issue:** During testing, Paystack checkout displayed the error: “We could not start this transaction. It's either because the link is incorrect or the transaction is already completed.”

**Diagnosis:** A checkout link can become unusable if a transaction has already been completed or the link is no longer valid. The exact cause of the observed error was not confirmed.

**Fix and current limitation:** The backend verifies transactions with Paystack before marking an order as paid. It checks the transaction status, amount, currency, and reference. However, I have not verified a live Paystack transaction as part of this audit, so the complete live payment flow remains to be confirmed.

**What Chord could improve:** Provide clearer guidance for integrating payment tools, handling failed or expired checkout links, and communicating payment status to the customer.

## 2. Order Notifications

**Issue:** I encountered a regression during development in which the Chord notification service and its call sites were removed. The notification service and calls were subsequently restored.

**Fix:** The backend now attempts to create Chord notification tasks after payment confirmation and when an order is marked ready for pickup. Notification failures are logged and do not reverse an order state that has already been committed.

**Current limitation:** Creating a notification task does not establish that the customer received the message. Automatic retries and delivery confirmation have not been implemented.

**What Chord could improve:** Provide clearer task-delivery statuses, actionable errors, and documentation showing how to confirm whether a scheduled message was actually delivered.

## 3. Outbound Message Delivery

**Issue:** During testing, payment-confirmation and pickup notification tasks were visible in Chord, but the messages did not appear in the TSG Labs simulator. The underlying delivery cause has not been confirmed.

**Investigation and workaround:** The backend sends scheduled message tasks to a configured Chord conversation. I moved the conversation ID into an environment variable rather than hardcoding it. However, the application does not yet map individual customers to their own Chord conversations, and successful task creation has not been confirmed as successful customer delivery.

**Current limitation:** Outbound customer delivery remains unverified. I would not consider this integration production-ready until delivery can be demonstrated and failures can be detected.

**What Chord could improve:** Document the supported outbound messaging flow, conversation identification and channel requirements, and how developers can inspect delivery status or diagnose undelivered messages.

## Verification and Production Readiness

Automated tests cover application logic and mocked integrations, but they do not prove that live Paystack transactions succeed or that Chord messages reach customers. The Chord error **“billing settlement failed after model completed”** was also observed during real conversations; its cause and effect on tool execution have not been established.

Before production, I would verify the live payment flow, confirm outbound delivery in the intended channel, implement notification retries and monitoring, and complete the required staff access controls.