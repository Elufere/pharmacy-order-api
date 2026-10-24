# Deployment field notes — Pharmacy Assistant

**Preferred role:** Forward-Deployed Engineering
**System:** Chord teammate (configuration is held in Chord, not this repository) → Node.js/Express API → PostgreSQL; Paystack is used for checkout and payment verification. The API's Chord notification sender creates scheduled tasks.

These notes distinguish source/commit evidence and mocked tests from external observations. The project history supplied for this audit reports that payment and pickup tasks/messages appeared in Chord, but no provider logs or screenshots are present in this repository. Delivery in `chat.tsglabs.dev` remains unverified. No live Paystack transaction was verified as part of this audit.

## 1. Payment confirmation must be based on Paystack verification

**Observed behavior / error evidence:** A checkout initialization response only gives a pending payment and checkout URL. The code does not treat that response as payment. No real Paystack error response or transaction log is retained here.

**Diagnosis and evidence:** `src/services/paystack.service.js` calls Paystack's server-side transaction verification endpoint, then checks provider status, exact kobo amount, currency, and reference. The payment row, invoice, and order are updated in a database transaction; it locks the order and rolls back if an expected update affects no row. `test/paystack.service.test.js` covers amount/currency/reference/status mismatches, transaction rollback, duplicate verification, and notification failure. These are mocked tests, not proof of a real charge.

**Root cause / fix:** Treating a browser return or checkout initialization as proof would allow an unpaid order to be marked paid. The implemented fix is server-side verification plus transactional state changes. The webhook additionally checks the raw-body HMAC signature and calls the same verification path for `charge.success`.

**Remaining risk:** Provider timeouts and database errors do not mark the invoice paid, but staff need an operational process to retry verification. There is no automated reconciliation job. Notification delivery is attempted after commit and has no persistent retry.

**Action for Chord:** Document how a Chord flow should hand a payment reference to the backend and wait for a verified backend result, including retry-safe behavior and what the customer should see while verification is unavailable. Do not encourage an agent to infer success from a checkout redirect.

## 2. Chord notification regression and order reference

**Observed behavior / exact error:** The commit history shows the notification service and pickup call site were removed in commit `af12c3f` (message: “fix: deliver pharmacy order notifications through Chord”), after they had been introduced in `50ae448`. No runtime error text from the regression is preserved, so none is asserted here. The prior payment verification query also did not select `o.order_ref` even though its notification call needed that value.

**Diagnosis and evidence:** `git show af12c3f` shows `src/services/chord.service.js` deleted and the pharmacist route's notification import/call removed. `git show c37b302` shows the service and pickup call restored, payment notification added, and `o.order_ref` added to the payment query. This is direct commit-diff evidence for the code-level regression and correction. It does not establish why the removal was made or prove a particular production error occurred.

**Root cause / fix:** Notification code and call sites were not retained across a change; in the restored payment call path, the selected record needed to include `order_ref`. The current query selects it and both post-commit call sites pass it to the shared Chord sender. Focused tests assert the order reference is in the task message, that payment notification follows commit, and that notification failure does not undo committed state. Chord service tests check a mocked task response and secret redaction.

**Regression prevention and limitation:** Keep tests around both notification call sites and verify the queried data includes the message's order reference. Repeated payment verification returns early after success; repeating the pickup transition is rejected before the notification call. A failure is logged but is not retried or alerted automatically.

**Action for Chord:** Provide a typed SDK/schema or validation error when a scheduled-task payload references unsupported fields or destinations, and document the required task response fields and delivery lifecycle. That would make integration regressions easier to diagnose than relying on a successful task-creation response alone.

## 3. Scheduled task observed, customer simulator delivery unresolved

**Observed behavior:** The supplied project history reports scheduled tasks and both payment-confirmation and pickup messages in Chord. It also reports that the messages did not appear in `https://chat.tsglabs.dev/`. No screenshot, task export, delivery receipt, or simulator trace is included here. There is no recorded HTTP error message for this delivery gap; do not infer one.

**Diagnosis:** The current API request uses `task_type: MESSAGE`, a `DIRECT_LINE` payload, and a configured `conversation_id`. The original code hardcoded one conversation ID; this audit removed that literal and made the destination an explicit `CHORD_CONVERSATION_ID` deployment setting. That removes a code-embedded destination but does not implement customer-specific routing. The backend stores an email but no customer-to-Chord-conversation mapping. The Chord API contract for delivering to a simulator/customer conversation and the authorization required to do so were not available in the repository; the simulator site was inaccessible through the available browser tool during the audit.

**Root cause / fix or workaround:** The confirmed facts establish task/message visibility in Chord and missing simulator appearance, not the underlying delivery cause. The safe workaround is to treat the Chord dashboard as the only observed destination, configure only a conversation authorized for that environment, and tell staff that customer receipt is unconfirmed. Do not claim customer delivery or use this for real customers.

**Action for Chord:** Publish the supported outbound messaging contract, including how to address an existing customer conversation, how identity mapping and consent work, which channel bindings are required, what response/status means “delivered,” and how to inspect a failed or undelivered task. Provide a test fixture or delivery receipt visible in the simulator.

## Verification boundary

The repository suite currently uses mocks for PostgreSQL, Paystack, and Chord. It verifies code paths and expected request construction; it does not verify an external Paystack payment, Chord task processing, or customer-facing simulator delivery. For those claims, attach redacted service/dashboard evidence and a simulator trace from an authorized environment.
