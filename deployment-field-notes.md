# Deployment Field Notes
## Community Pharmacy Order & Stock Agent

**Project:** Pharmacy Assistant  
**Platform:** Chord  
**Backend:** Node.js and Express  
**Database:** PostgreSQL  
**Hosting:** Render  
**Integration channel:** Chord test conversation and WhatsApp-style simulator

### 1. Deployment Summary

I built and deployed an AI pharmacy assistant that checks product inventory and prices, prepares order summaries, and submits orders after explicit customer confirmation.

The backend is hosted on Render and connected to PostgreSQL. Two custom API tools were configured in Chord:

- **Search Pharmacy Inventory:** Retrieves product names, prices, units, and current stock.
- **Create Pharmacy Order:** Creates an order and returns an order reference, total, and fulfilment status.

The deployment was verified through the health endpoint, direct API tests, and an end-to-end conversation with Pharmacy Assistant.

### 2. Issues Encountered and Resolutions

#### Issue 1: Git push rejected because the remote contained existing history

**Observed error:** Git rejected the initial push to `main` because the remote repository contained commits not present in the local repository. After pulling with `--allow-unrelated-histories`, Git reported a conflict in `README.md`.

**Root cause:** The local project and the existing GitHub repository had separate histories, and both contained a README file.

**Resolution:** I resolved the README conflict, staged the file, committed the merge, and pushed the branch. Render subsequently deployed the repository's `main` branch.

**Lesson:** Check the remote repository before the first push. When merging unrelated histories, inspect both versions of conflicting files rather than automatically overwriting one. Verify the final commit contains the intended application code before deploying.

#### Issue 2: The initial simulator did not clearly identify the intended teammate

**Observed behaviour:** The WhatsApp Simulator initially displayed “Chord Assistant,” while the intended agent was “Pharmacy Assistant.” The Pharmacy Assistant settings also showed that no messaging channel was bound to the teammate.

**Root cause:** The initial simulator link and the intended teammate's test conversation were separate testing contexts.

**Resolution:** I opened Pharmacy Assistant's dedicated test conversation and tested the inventory and order flows there. The teammate successfully invoked the custom inventory tool and created an order after explicit confirmation.

**Lesson:** Test the intended teammate directly before assuming a shared simulator link is exercising the correct agent. Before go-live, verify the production channel is bound to the intended teammate.

#### Issue 3: Inventory changed during testing

**Observed behaviour:** Paracetamol stock decreased from 20 packs to 19, then 18, and subsequently 16 as test orders were created.

**Root cause:** The test requests created real records in the demo PostgreSQL database and decremented inventory as designed.

**Resolution:** I checked the returned inventory values and confirmed they reflected the submitted test orders.

**Lesson:** API tests that mutate state should use a dedicated test database or a documented reset procedure. Repeated test runs should not be assumed to be read-only. Before a demonstration, seed known inventory values and verify the starting state.

### 3. Verification Results

The following checks passed:

- The `/health` endpoint returned `status: ok` and `database: connected`.
- The inventory endpoint returned the expected seeded products and current stock.
- The inventory API tool returned live data to Pharmacy Assistant.
- The order API created orders and returned unique order references.
- The assistant calculated the total correctly for two packs of Paracetamol at ₦1,500 per pack.
- The assistant requested explicit confirmation before submitting the order.
- After confirmation, the assistant returned the order reference and `awaiting_pharmacy_confirmation` status.
- A declined, unconfirmed Vitamin C order was not submitted, and no order-creation tool call appeared in the conversation's visible tool activity.

### 4. Remaining Risks and Limitations

This is a functional demonstration, not a production-ready pharmacy system.

- **Order cancellation:** The assistant cannot directly cancel or modify submitted orders. A real deployment needs a defined cancellation and escalation workflow.
- **Pharmacy fulfilment:** Orders remain pending pharmacy confirmation. No fulfilment or delivery integration has been implemented.
- **Authentication and abuse prevention:** The public API needs appropriate authentication, rate limiting, and access controls before being exposed to real customers.
- **Concurrency and reliability:** Stock updates must remain correct under simultaneous orders, retries, and service interruptions. These cases require additional automated tests.
- **Customer data:** Only fictional demonstration data should be used until privacy and data-retention controls are established.
- **Free hosting:** Render's free web service may spin down after inactivity, causing slower initial responses. This can affect the customer experience.
- **Medical safety:** The assistant must not diagnose conditions or independently recommend medication. Medical questions should be referred to a qualified pharmacist.

### 5. Recommendations Before Go-Live

1. Add automated tests for insufficient stock, invalid quantities, duplicate requests, database failures, and concurrent orders.
2. Add authenticated API access and rate limiting.
3. Implement a pharmacy review workflow for accepting, rejecting, or cancelling orders.
4. Establish monitoring, structured logs, alerts, backups, and a recovery procedure.
5. Test the actual customer messaging channel with the intended teammate.
6. Review privacy, consent, retention, and operational requirements before using real customer information.
7. Run a controlled pilot with a pharmacist supervising all orders before wider release.

### 6. Overall Assessment

The demonstration successfully connects a Chord AI teammate to a deployed backend and persistent database. It verifies the core inventory-to-order workflow, including explicit customer confirmation and clear communication that an order is pending pharmacy review.

The next stage is reliability and operational hardening, not adding more conversational features. The priority is ensuring that inventory remains accurate, order creation is safe under failure conditions, and pharmacy staff retain control over fulfilment.
