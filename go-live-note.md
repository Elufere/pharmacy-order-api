# Pharmacy owner go-live note

The assistant can answer stock and price questions, prepare an itemized order, and submit it after the customer confirms. Paystack payment is confirmed by the backend before staff can mark an order ready for pickup. It does not diagnose, prescribe, arrange delivery, cancel orders, or issue refunds.

This demo must use Paystack **test** credentials and fictional customer information. Production credentials must not be used until the pharmacy has completed a supervised pilot and approved security, privacy, payment, backup, and recovery procedures. WhatsApp or another messaging channel must be properly connected to the intended Chord teammate and tested with the pharmacy's authorized account.

If payment fails or cannot be verified, the order remains unpaid; staff should check the order/payment state and contact the customer through a confirmed channel. Chord notification failures are logged, but there is no automatic retry or staff alert. Staff must check the Chord dashboard after payment and pickup transitions and follow up manually if a task is missing. Messages have been observed in Chord, but delivery to the customer-facing simulator has not been verified. The current setup uses one configured Direct Line destination and does not map customers to their own conversations.

Before launch, the owner must assign a person to monitor payment and notification failures, confirm customer identity and consent mapping, test both message events end to end in the real channel, validate staff access, and rehearse database backup and recovery with a pharmacist supervising every order. This demo is not production-ready.
