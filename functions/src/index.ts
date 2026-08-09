import {randomUUID} from "node:crypto";
import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import {initializeApp} from "firebase-admin/app";
import {
  DocumentReference,
  FieldValue,
  Firestore,
  getFirestore,
} from "firebase-admin/firestore";
import {getStorage} from "firebase-admin/storage";
import Stripe from "stripe";

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({maxInstances: 10});

initializeApp();
const stripeSecretParam = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecretParam = defineSecret("STRIPE_WEBHOOK_SECRET");
const gmailSendClientIdParam = defineSecret("GMAIL_SEND_CLIENT_ID");
const gmailSendClientSecretParam = defineSecret("GMAIL_SEND_CLIENT_SECRET");
const gmailSendRefreshTokenParam = defineSecret("GMAIL_SEND_REFRESH_TOKEN");
const gmailSendFromParam = defineSecret("GMAIL_SEND_FROM");
const gmailSpeakerSendClientIdParam = defineSecret(
  "GMAIL_SPEAKER_SEND_CLIENT_ID",
);
const gmailSpeakerSendClientSecretParam = defineSecret(
  "GMAIL_SPEAKER_SEND_CLIENT_SECRET",
);
const gmailSpeakerSendRefreshTokenParam = defineSecret(
  "GMAIL_SPEAKER_SEND_REFRESH_TOKEN",
);
const gmailSpeakerSendFromParam = defineSecret("GMAIL_SPEAKER_SEND_FROM");
const stripeInvoiceTemplateId = "inrtem_1U0L26J1nXZVJIUSnNARAePJ";
const stripeInvoicePriceId = "price_1TnIigJ1nXZVJIUS4KTefGCf";

/**
 * Picks the best available guest email field from Firestore data.
 * @param {Record<string, unknown>} data Firestore guest item data.
 * @return {string} A validated email string or empty string.
 */
function pickGuestEmail(data: Record<string, unknown>): string {
  const candidates = [
    data.email,
    data.guestEmail,
    data["E-mail"],
    data.Email,
    data["E mail"],
  ];
  for (const value of candidates) {
    const email = String(value || "").trim();
    if (email.includes("@")) return email;
  }
  return "";
}

/**
 * Picks the best available guest display name from Firestore data.
 * Falls back to email local-part if no explicit name exists.
 * @param {Record<string, unknown>} data Firestore guest item data.
 * @param {string} email Guest email (optional fallback source).
 * @return {string} Guest display name.
 */
function pickGuestName(data: Record<string, unknown>, email: string): string {
  const fullNameCandidates = [
    data.name,
    data.Name,
    data.fullName,
    data["Full name"],
    data["Guest name"],
  ];
  for (const value of fullNameCandidates) {
    const v = String(value || "").trim();
    if (v) return v;
  }

  const first = String(
    data.firstName ||
      data.firstname ||
      data["First name"] ||
      data.Firstname ||
      ""
  ).trim();
  const last = String(
    data.lastName ||
      data.lastname ||
      data["Last name"] ||
      data.Lastname ||
      ""
  ).trim();
  const combined = `${first} ${last}`.trim();
  if (combined) return combined;

  const mail = String(email || "").trim();
  if (mail.includes("@")) return mail.split("@")[0];
  return "Guest";
}

/**
 * Creates a YYMMDD prefix used in guest log lines.
 * @return {string} Date prefix such as 260505.
 */
function guestLogPrefixYyMmDd(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * First log line when a guest applies via the public registration form.
 * @return {string} e.g. `260522: Application received`.
 */
function guestLogApplicationReceivedLine(): string {
  return `${guestLogPrefixYyMmDd()}: Application received`;
}

/**
 * Log line after invitation e-mail is sent from the guest workflow.
 * @return {string} e.g. `260802: Invitation emailed to guest.`
 */
function guestLogInvitationEmailedLine(): string {
  return `${guestLogPrefixYyMmDd()}: Invitation emailed to guest.`;
}

/**
 * Escape text for safe insertion into HTML e-mail templates.
 * @param {string} text Raw text.
 * @return {string} Escaped HTML text.
 */
function escapeHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Read Current event from tbs/Settings.
 * @param {Firestore} db Firestore instance.
 * @return {Promise<string>} Current event label or empty string.
 */
async function loadCurrentEventLabel(db: Firestore): Promise<string> {
  const snap = await db.collection("tbs").doc("Settings").get();
  const data = (snap.exists ? snap.data() : null) || {};
  const keys = [
    "Current event",
    "currentEvent",
    "Current Event",
    "CURRENT EVENT",
  ];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const v = String(data[key] || "").trim();
      if (v) return v;
    }
  }
  return "";
}

/**
 * Load guest invitation HTML from tbs/Snippets.
 * @param {Firestore} db Firestore instance.
 * @return {Promise<string>} HTML template string.
 */
async function loadGuestInvitationHtml(db: Firestore): Promise<string> {
  const snap = await db.collection("tbs").doc("Snippets").get();
  const data = (snap.exists ? snap.data() : null) || {};
  const raw = data["Guest invitation"];
  return raw != null ? String(raw) : "";
}

/**
 * Load speaker invitation HTML + optional subject from
 * tbs/Snippets.Speakerinvitation.
 * @param {Firestore} db Firestore instance.
 * @return {Promise<{html: string, subject: string}>} Template fields.
 */
async function loadSpeakerInvitationFromSnippets(
  db: Firestore,
): Promise<{html: string; subject: string}> {
  const snap = await db.collection("tbs").doc("Snippets").get();
  const data = (snap.exists ? snap.data() : null) || {};
  const raw = data.Speakerinvitation;
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    let html = "";
    if (obj.html != null) html = String(obj.html);
    else if (obj.body != null) html = String(obj.body);
    else if (obj.HTML != null) html = String(obj.HTML);
    const subject = obj.subject != null ?
      String(obj.subject) :
      obj.Subject != null ? String(obj.Subject) : "";
    return {html, subject};
  }
  return {html: raw != null ? String(raw) : "", subject: ""};
}

/**
 * Pick speaker email from Firestore item fields.
 * @param {Record<string, unknown>} data Speaker item data.
 * @return {string} Email or empty.
 */
function pickSpeakerEmail(data: Record<string, unknown>): string {
  // Primary: tbs/Speakers/{id}/item `email` field (same as Speakers roster).
  const primary = String(data.email || "").trim();
  if (primary.includes("@")) return primary;
  const candidates = [
    data.Email,
    data["E-mail"],
    data["E mail"],
  ];
  for (const value of candidates) {
    const email = String(value || "").trim();
    if (email.includes("@")) return email;
  }
  return "";
}

/**
 * Pick speaker first name for template tokens.
 * @param {Record<string, unknown>} data Speaker item data.
 * @return {string} First name or empty.
 */
function pickSpeakerFirstName(data: Record<string, unknown>): string {
  const candidates = [
    data.firstName,
    data.FirstName,
    data["First name"],
    data["First Name"],
    data.Name,
    data.name,
  ];
  for (const value of candidates) {
    const v = String(value || "").trim();
    if (v) return v.split(/\s+/)[0] || v;
  }
  return "";
}

/**
 * Normalize speaker Status / inviteStatus for workflow gates.
 * @param {Record<string, unknown>} data Speaker item data.
 * @return {string} Preliminary | Confirmed | Invited | Cancel | other.
 */
function normalizeSpeakerStatus(data: Record<string, unknown>): string {
  const raw = String(
    data.Status ?? data.inviteStatus ?? data["Invite status"] ?? "",
  ).trim();
  if (!raw) return "Preliminary";
  const low = raw.toLowerCase();
  if (low === "none" || low === "no" || low === "n" || low === "preliminary") {
    return "Preliminary";
  }
  if (low === "confirmed" || low === "accepted") return "Confirmed";
  if (low === "invited") return "Invited";
  if (low === "cancel" || low === "cancelled" || low === "canceled") {
    return "Cancel";
  }
  return raw;
}

/**
 * Formal speaker invite only when Status is Confirmed.
 * @param {Record<string, unknown>} data Speaker item data.
 * @return {boolean} Whether invite may be sent.
 */
function speakerFormalInviteAllowed(data: Record<string, unknown>): boolean {
  return normalizeSpeakerStatus(data) === "Confirmed";
}

/**
 * Speaker log line for formal invite sent.
 * @return {string} e.g. `260809: Formal invite sent`
 */
function speakerLogFormalInviteSentLine(): string {
  return guestLogPrefixYyMmDd() + ": Formal invite sent";
}

/**
 * Refresh a Gmail OAuth access token using the stored refresh token.
 * @return {Promise<string>} Access token.
 */
async function refreshGmailSendAccessToken(): Promise<string> {
  const clientId = String(gmailSendClientIdParam.value() || "").trim();
  const clientSecret = String(gmailSendClientSecretParam.value() || "").trim();
  const refreshToken = String(gmailSendRefreshTokenParam.value() || "").trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Gmail send OAuth secrets.");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: body.toString(),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const errMsg = String(
      json.error_description || json.error || res.statusText,
    );
    throw new Error("Gmail token refresh failed: " + errMsg);
  }
  const accessToken = String(json.access_token || "").trim();
  if (!accessToken) {
    throw new Error("Gmail token refresh returned no access_token.");
  }
  return accessToken;
}

/**
 * Refresh Gmail access token for the speaker invite mailbox (info@…).
 * Uses GMAIL_SPEAKER_SEND_* secrets only — guest secrets are untouched.
 * @return {Promise<string>} Access token.
 */
async function refreshGmailSpeakerSendAccessToken(): Promise<string> {
  const clientId = String(gmailSpeakerSendClientIdParam.value() || "").trim();
  const clientSecret = String(
    gmailSpeakerSendClientSecretParam.value() || "",
  ).trim();
  const refreshToken = String(
    gmailSpeakerSendRefreshTokenParam.value() || "",
  ).trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing speaker Gmail send OAuth secrets.");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: body.toString(),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const errMsg = String(
      json.error_description || json.error || res.statusText,
    );
    throw new Error("Speaker Gmail token refresh failed: " + errMsg);
  }
  const accessToken = String(json.access_token || "").trim();
  if (!accessToken) {
    throw new Error("Speaker Gmail token refresh returned no access_token.");
  }
  return accessToken;
}

/**
 * Encode an RFC822 message for Gmail API `raw`.
 * @param {string} rfc822 Message text.
 * @return {string} Base64url string.
 */
function gmailRfc822ToBase64Url(rfc822: string): string {
  return Buffer.from(rfc822, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Send an HTML e-mail via Gmail API as the configured From address.
 * @param {string} accessToken OAuth access token.
 * @param {object} opts Mail fields.
 * @return {Promise<void>}
 */
async function sendGmailHtmlMessage(
  accessToken: string,
  opts: {from: string; to: string; subject: string; html: string},
): Promise<void> {
  const from = String(opts.from || "").trim();
  const to = String(opts.to || "").trim();
  const subject = String(opts.subject || "").replace(/[\r\n]/g, " ").trim();
  const html = String(opts.html || "");
  if (!from || !to || !subject) {
    throw new Error("Missing From, To, or Subject for invite e-mail.");
  }
  const rfc822 = [
    "From: " + from,
    "To: " + to,
    "Subject: " + subject,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
  ].join("\r\n");
  const raw = gmailRfc822ToBase64Url(rfc822);
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({raw}),
    },
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      "Gmail send failed (" + res.status + "): " + (errText || res.statusText),
    );
  }
}

/**
 * True when guest Read is Yes and Invited is No (invite workflow gate).
 * @param {Record<string, unknown>} data Guest item data.
 * @return {boolean} Whether invite may be sent.
 */
function guestInviteAllowed(data: Record<string, unknown>): boolean {
  const read = String(
    data.Read ?? data.read ?? data.READ ?? "",
  ).trim();
  const invited = String(
    data.Invited ?? data.invited ?? "",
  ).trim();
  return read === "Yes" && invited === "No";
}

/**
 * Human-readable calendar date for guest invoice records.
 * @param {Date} date Invoice send timestamp.
 * @return {string} Date string such as 2026-05-11.
 */
function formatGuestInvoicedDateDisplay(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Builds customer full name from Firebase "Full name".
 * @param {Record<string, unknown>} data Firestore guest item data.
 * @param {string} fallbackName Fallback display name.
 * @return {string} Full name for Stripe customer.
 */
function pickCustomerFullName(
  data: Record<string, unknown>,
  fallbackName: string
): string {
  const fullName = String(
    data["Full name"] ||
    data["Full Name"] ||
    data.fullName ||
    ""
  ).trim();
  return fullName || String(fallbackName || "").trim() || "Guest";
}

export const createGuestStripeInvoiceHttp = onRequest({
  secrets: [stripeSecretParam],
  invoker: "public",
  cors: true,
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({error: "Method not allowed"});
    return;
  }

  const stripeSecret = String(stripeSecretParam.value() || "").trim();
  if (!stripeSecret) {
    res.status(500).json({
      error: "Missing STRIPE_SECRET_KEY in functions environment.",
    });
    return;
  }
  const stripe = new Stripe(stripeSecret);

  const body = (req.body || {}) as Record<string, unknown>;
  const guestId = String(body.guestId || "").trim();
  if (!guestId) {
    res.status(400).json({error: "Missing guestId."});
    return;
  }

  const db = getFirestore();
  const itemRef = db
    .collection("tbs")
    .doc("Guests")
    .collection(guestId)
    .doc("item");

  try {
    const snap = await itemRef.get();
    if (!snap.exists) {
      res.status(404).json({error: "Guest item not found."});
      return;
    }
    const data = snap.data() || {};
    const email = pickGuestEmail(data);
    if (!email) {
      res.status(400).json({error: "Guest has no valid email."});
      return;
    }
    const guestName = pickGuestName(data, email);
    const customerFullName = pickCustomerFullName(data, guestName);

    // Step 1: Create or reuse Stripe customer only.
    // Reuse only when both email and full name match.
    const existingCustomers = await stripe.customers.list({
      email: email,
      limit: 100,
    });
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const normalizedName = String(customerFullName || "").trim();
    const existingCustomer = existingCustomers.data.find((candidate) => {
      const candidateEmail = String(candidate.email || "").trim().toLowerCase();
      const candidateName = String(candidate.name || "").trim();
      return candidateEmail === normalizedEmail &&
        candidateName === normalizedName;
    }) || null;
    const customer = existingCustomer || await stripe.customers.create({
      email: email,
      name: customerFullName || "Guest",
    });
    const alreadyExisted = Boolean(existingCustomer);

    const logLine = `${guestLogPrefixYyMmDd()}: ` +
      `Stripe customer ${alreadyExisted ? "already exists" : "generated"} ` +
      `(${customer.id}).`;
    await itemRef.set({
      "Stripe Customer Id": customer.id,
      "Log": FieldValue.arrayUnion(logLine),
    }, {merge: true});

    logger.info("createGuestStripeInvoiceHttp Step 1", {
      guestId: guestId,
      customerId: customer.id,
      alreadyExisted: alreadyExisted,
    });

    // Step 2: Create draft invoice and attach invoice item.
    const refreshedSnap = await itemRef.get();
    const refreshedData = refreshedSnap.data() || {};
    const storedCustomerId = String(
      refreshedData["Stripe Customer Id"] || ""
    ).trim();
    if (!storedCustomerId) {
      res.status(500).json({
        error: "Missing Stripe Customer Id in guest record after Step 1.",
      });
      return;
    }

    const invoice = await stripe.invoices.create({
      customer: storedCustomerId,
      collection_method: "send_invoice",
      days_until_due: 30,
      auto_advance: false,
      currency: "eur",
      rendering: {template: stripeInvoiceTemplateId},
      metadata: {
        guestId: guestId,
        tbsGuestPath: `tbs/Guests/${guestId}/item`,
      },
    });
    await stripe.invoiceItems.create({
      customer: storedCustomerId,
      pricing: {price: stripeInvoicePriceId},
      invoice: invoice.id,
    });

    const draftLogLine = `${guestLogPrefixYyMmDd()}: ` +
      `Stripe draft invoice generated (${invoice.id}).`;
    await itemRef.set({
      "Stripe Invoice Id": invoice.id,
      "Stripe Invoice Status": invoice.status || "draft",
      "Invoice created": String(invoice.created || ""),
      "Stripe Invoice Template Id Used": stripeInvoiceTemplateId,
      "Stripe Invoice Price Id Used": stripeInvoicePriceId,
      "Log": FieldValue.arrayUnion(draftLogLine),
    }, {merge: true});

    logger.info("createGuestStripeInvoiceHttp Step 2", {
      guestId: guestId,
      customerId: storedCustomerId,
      invoiceId: invoice.id,
      invoiceStatus: invoice.status || "draft",
    });

    // Step 3: Finalize draft invoice and email it to the guest.
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(finalizedInvoice.id);

    const sentLogLine = `${guestLogPrefixYyMmDd()}: ` +
      `Stripe invoice finalized and sent (${finalizedInvoice.id}).`;
    const invoicedDate = formatGuestInvoicedDateDisplay(new Date());
    const alreadyPaid = String(refreshedData["Paid"] || "")
      .trim()
      .toLowerCase() === "yes";
    const paidPatch: Record<string, unknown> = alreadyPaid ?
      {} :
      {"Paid": "No"};
    await itemRef.set({
      "Invoiced": "Yes",
      ...paidPatch,
      "Invoiced date": invoicedDate,
      "Stripe Invoice Id": finalizedInvoice.id,
      "Stripe Invoice Status": finalizedInvoice.status || "open",
      "Stripe Invoice Url": finalizedInvoice.hosted_invoice_url || "",
      "Invoice created": String(finalizedInvoice.created || ""),
      "Stripe Invoice Template Id Used": stripeInvoiceTemplateId,
      "Stripe Invoice Price Id Used": stripeInvoicePriceId,
      "Log": FieldValue.arrayUnion(sentLogLine),
    }, {merge: true});

    logger.info("createGuestStripeInvoiceHttp Step 3", {
      guestId: guestId,
      customerId: storedCustomerId,
      invoiceId: finalizedInvoice.id,
      invoiceStatus: finalizedInvoice.status || "open",
    });

    res.status(200).json({
      ok: true,
      step: "Step 3",
      customerId: storedCustomerId,
      customerExists: alreadyExisted,
      invoiceId: finalizedInvoice.id,
      invoicedDate: invoicedDate,
      logLine: sentLogLine,
      message: "Invoice sent",
    });
  } catch (err) {
    logger.error("createGuestStripeInvoice", {guestId: guestId, err: err});
    res.status(500).json({
      error: err instanceof Error ?
        err.message :
        "Stripe invoice generation failed.",
    });
  }
});

/**
 * Minimal invoice fields used when matching a paid Stripe invoice to a guest.
 */
type StripePaidInvoiceFields = {
  id?: string | null;
  number?: string | null;
  status?: string | null;
  paid?: boolean | null;
  amount_remaining?: number | null;
  customer?: unknown;
  customer_email?: string | null;
  metadata?: Record<string, string> | null;
  hosted_invoice_url?: string | null;
  created?: number | null;
};

/**
 * Whether a Stripe invoice should count as paid for guest reconciliation.
 * @param {StripePaidInvoiceFields} invoice Stripe invoice-like object.
 * @return {boolean} True when paid.
 */
function isStripeInvoicePaid(invoice: StripePaidInvoiceFields): boolean {
  if (!invoice) return false;
  if (String(invoice.status || "").trim().toLowerCase() === "paid") return true;
  if (invoice.paid === true) return true;
  if (
    typeof invoice.amount_remaining === "number" &&
    invoice.amount_remaining === 0 &&
    String(invoice.status || "").trim().toLowerCase() !== "draft" &&
    String(invoice.status || "").trim().toLowerCase() !== "void"
  ) {
    return true;
  }
  return false;
}

type GuestItemIndexEntry = {
  guestId: string;
  ref: DocumentReference;
  data: Record<string, unknown>;
};

/**
 * Load every tbs/Guests/{id}/item doc for matching and reconcile.
 * @param {Firestore} db Admin Firestore.
 * @return {Promise<GuestItemIndexEntry[]>} Guest item entries.
 */
async function loadAllGuestItemEntries(
  db: Firestore,
): Promise<GuestItemIndexEntry[]> {
  const guestCols = await db.collection("tbs").doc("Guests").listCollections();
  const entries: GuestItemIndexEntry[] = [];
  for (const col of guestCols) {
    const snap = await col.doc("item").get();
    if (!snap.exists) continue;
    entries.push({
      guestId: col.id,
      ref: snap.ref,
      data: snap.data() || {},
    });
  }
  return entries;
}

/**
 * Resolve guest item ref from a paid Stripe invoice.
 * Order: metadata.guestId (if doc exists) → Stripe Invoice Id →
 * Stripe Customer Id → guest email vs invoice.customer_email.
 * @param {Firestore} db Admin Firestore.
 * @param {StripePaidInvoiceFields} invoice Paid invoice.
 * @param {GuestItemIndexEntry[]=} guestEntries Optional preloaded guests.
 * @return {Promise<DocumentReference|null>} Guest item ref or null.
 */
async function findGuestItemRefForStripeInvoice(
  db: Firestore,
  invoice: StripePaidInvoiceFields,
  guestEntries?: GuestItemIndexEntry[],
): Promise<DocumentReference | null> {
  const entries = guestEntries || await loadAllGuestItemEntries(db);
  const metaGuestId = String(
    (invoice.metadata && invoice.metadata.guestId) || "",
  ).trim();
  if (metaGuestId) {
    const byMeta = entries.find((e) => e.guestId === metaGuestId);
    if (byMeta) return byMeta.ref;
    const metaRef = db.collection("tbs").doc("Guests")
      .collection(metaGuestId).doc("item");
    const metaSnap = await metaRef.get();
    if (metaSnap.exists) return metaRef;
  }

  const invoiceId = String(invoice.id || "").trim();
  if (invoiceId) {
    const byInvoice = entries.find((e) => {
      const storedId = String(e.data["Stripe Invoice Id"] || "").trim();
      return storedId && storedId === invoiceId;
    });
    if (byInvoice) return byInvoice.ref;
  }

  const customerId = typeof invoice.customer === "string" ?
    String(invoice.customer).trim() :
    "";
  if (customerId) {
    const byCustomer = entries.find((e) => {
      const stored = String(e.data["Stripe Customer Id"] || "").trim();
      return stored && stored === customerId;
    });
    if (byCustomer) return byCustomer.ref;
  }

  const invoiceEmail = String(invoice.customer_email || "")
    .trim()
    .toLowerCase();
  if (invoiceEmail) {
    const byEmail = entries.find((e) => {
      const guestEmail = pickGuestEmail(e.data).toLowerCase();
      return guestEmail && guestEmail === invoiceEmail;
    });
    if (byEmail) return byEmail.ref;
  }

  return null;
}

/**
 * Mark a guest Paid=Yes from a Stripe paid invoice (idempotent log).
 * @param {DocumentReference} itemRef Guest item ref.
 * @param {StripePaidInvoiceFields} invoice Paid invoice.
 * @return {Promise<{updated: boolean, alreadyPaid: boolean}>} Result.
 */
async function applyStripePaidInvoiceToGuest(
  itemRef: DocumentReference,
  invoice: StripePaidInvoiceFields,
): Promise<{updated: boolean; alreadyPaid: boolean}> {
  const snap = await itemRef.get();
  if (!snap.exists) {
    return {updated: false, alreadyPaid: false};
  }
  const data = snap.data() || {};
  const alreadyPaid = String(data["Paid"] || "").trim().toLowerCase() === "yes";
  const paidDate = alreadyPaid && String(data["Paid date"] || "").trim() ?
    String(data["Paid date"]).trim() :
    formatGuestInvoicedDateDisplay(
      invoice.created ? new Date(invoice.created * 1000) : new Date(),
    );
  const patch: Record<string, unknown> = {
    "Paid": "Yes",
    "Paid date": paidDate,
    "Stripe Invoice Id": invoice.id || data["Stripe Invoice Id"] || "",
    "Stripe Invoice Status": invoice.status || "paid",
    "Stripe Invoice Number": invoice.number || "",
    "Stripe Invoice Url":
      invoice.hosted_invoice_url || data["Stripe Invoice Url"] || "",
  };
  if (!alreadyPaid) {
    const logLine = `${guestLogPrefixYyMmDd()}: ` +
      `Payment received on ${paidDate}` +
      (invoice.id ? ` (${invoice.id}` : "") +
      (invoice.number ? `, number ${invoice.number}` : "") +
      (invoice.id ? ")" : "") +
      ".";
    patch["Log"] = FieldValue.arrayUnion(logLine);
  }
  await itemRef.set(patch, {merge: true});
  return {updated: !alreadyPaid, alreadyPaid};
}

/**
 * Whether a Stripe webhook event should mark a guest paid.
 * @param {string} type Stripe event type.
 * @return {boolean} True for paid invoice events.
 */
function isStripePaidInvoiceEventType(type: string): boolean {
  return type === "invoice.paid" || type === "invoice.payment_succeeded";
}

/**
 * Stripe webhook: on invoice.paid / invoice.payment_succeeded,
 * set guest Paid=Yes + invoice fields.
 * Configure endpoint in Stripe Live Dashboard → Developers → Webhooks.
 */
export const stripeWebhookHttp = onRequest({
  secrets: [stripeSecretParam, stripeWebhookSecretParam],
  invoker: "public",
}, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const stripeSecret = String(stripeSecretParam.value() || "").trim();
  const webhookSecret = String(stripeWebhookSecretParam.value() || "").trim();
  if (!stripeSecret || !webhookSecret) {
    res.status(500).send("Missing Stripe secrets.");
    return;
  }

  const stripe = new Stripe(stripeSecret);
  const signature = String(req.headers["stripe-signature"] || "");
  // Firebase provides the raw body buffer required for signature verification.
  const rawBody = (req as {rawBody?: Buffer}).rawBody;
  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    logger.error("stripeWebhookHttp: missing rawBody");
    res.status(400).send("Missing raw body.");
    return;
  }

  let event: {type: string; data: {object: StripePaidInvoiceFields}};
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      webhookSecret,
    ) as {type: string; data: {object: StripePaidInvoiceFields}};
  } catch (err) {
    logger.error("stripeWebhookHttp signature verify failed", {err});
    res.status(400).send(
      `Webhook signature verification failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
    return;
  }

  try {
    if (isStripePaidInvoiceEventType(event.type)) {
      const invoice = event.data.object;
      if (String(invoice.status || "").trim() &&
        String(invoice.status).trim() !== "paid") {
        res.status(200).json({
          ok: true,
          ignored: event.type,
          reason: "not_paid",
          status: invoice.status,
        });
        return;
      }
      const db = getFirestore();
      const itemRef = await findGuestItemRefForStripeInvoice(db, invoice);
      if (!itemRef) {
        logger.warn("stripeWebhookHttp: no guest for invoice", {
          invoiceId: invoice.id,
          customer: invoice.customer,
          customerEmail: invoice.customer_email,
          metaGuestId: invoice.metadata && invoice.metadata.guestId,
        });
        // Non-2xx so Stripe retries; guest may get linked later.
        res.status(404).json({ok: false, matched: false});
        return;
      }

      const result = await applyStripePaidInvoiceToGuest(itemRef, invoice);
      logger.info("stripeWebhookHttp paid invoice applied", {
        eventType: event.type,
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        guestPath: itemRef.path,
        updated: result.updated,
        alreadyPaid: result.alreadyPaid,
      });
      res.status(200).json({
        ok: true,
        matched: true,
        updated: result.updated,
        alreadyPaid: result.alreadyPaid,
      });
      return;
    }

    res.status(200).json({ok: true, ignored: event.type});
  } catch (err) {
    logger.error("stripeWebhookHttp handler error", {err, type: event.type});
    res.status(500).send(
      err instanceof Error ? err.message : "Webhook handler failed.",
    );
  }
});

/**
 * Backfill Paid=Yes for guests whose Stripe invoices are already paid.
 * POST JSON: { guestId?: string, lookbackDays?: number }
 * Checks each unpaid invoiced guest's Stripe Invoice Id, then also scans
 * recent Stripe paid invoices for unmatched guests.
 */
export const reconcileStripePaidInvoicesHttp = onRequest({
  secrets: [stripeSecretParam],
  timeoutSeconds: 300,
  invoker: "public",
  cors: true,
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({error: "Method not allowed"});
    return;
  }

  const stripeSecret = String(stripeSecretParam.value() || "").trim();
  if (!stripeSecret) {
    res.status(500).json({
      error: "Missing STRIPE_SECRET_KEY in functions environment.",
    });
    return;
  }
  const stripe = new Stripe(stripeSecret);
  const body = (req.body || {}) as Record<string, unknown>;
  const filterGuestId = String(body.guestId || "").trim();
  const lookbackDaysRaw = Number(body.lookbackDays);
  const lookbackDays = Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0 ?
    Math.min(Math.floor(lookbackDaysRaw), 365) :
    90;
  const createdGte = Math.floor(Date.now() / 1000) - (lookbackDays * 86400);

  const db = getFirestore();
  const summary = {
    ok: true,
    checked: 0,
    updated: 0,
    alreadyPaid: 0,
    openOrUnpaid: 0,
    unmatchedStripe: 0,
    updatedGuestIds: [] as string[],
    unmatchedInvoiceIds: [] as string[],
  };

  try {
    const entries = await loadAllGuestItemEntries(db);
    const scoped = filterGuestId ?
      entries.filter((e) => e.guestId === filterGuestId) :
      entries;

    const unpaidWithInvoice = scoped.filter((entry) => {
      const paidYes = String(entry.data["Paid"] || "")
        .trim()
        .toLowerCase() === "yes";
      const invoiceId = String(entry.data["Stripe Invoice Id"] || "").trim();
      if (!invoiceId) return false;
      if (paidYes) {
        summary.alreadyPaid++;
        return false;
      }
      return true;
    });

    const retrieveOne = async (entry: GuestItemIndexEntry) => {
      const invoiceId = String(entry.data["Stripe Invoice Id"] || "").trim();
      summary.checked++;
      try {
        const invoice = await stripe.invoices.retrieve(invoiceId);
        const invoiceFields: StripePaidInvoiceFields = {
          id: invoice.id,
          number: invoice.number,
          status: invoice.status,
          amount_remaining: invoice.amount_remaining,
          customer: invoice.customer,
          customer_email: invoice.customer_email,
          metadata: invoice.metadata as Record<string, string> | null,
          hosted_invoice_url: invoice.hosted_invoice_url,
          created: invoice.created,
        };
        if (!isStripeInvoicePaid(invoiceFields)) {
          summary.openOrUnpaid++;
          return;
        }
        const result = await applyStripePaidInvoiceToGuest(
          entry.ref,
          invoiceFields,
        );
        if (result.updated) {
          summary.updated++;
          summary.updatedGuestIds.push(entry.guestId);
        } else if (result.alreadyPaid) {
          summary.alreadyPaid++;
        }
      } catch (err) {
        logger.warn("reconcileStripePaidInvoicesHttp retrieve failed", {
          guestId: entry.guestId,
          invoiceId,
          err,
        });
      }
    };

    const concurrency = 8;
    for (let i = 0; i < unpaidWithInvoice.length; i += concurrency) {
      const batch = unpaidWithInvoice.slice(i, i + concurrency);
      await Promise.all(batch.map((entry) => retrieveOne(entry)));
    }

    // Second pass: recent paid Stripe invoices for unpaid / unlinked guests.
    let startingAfter: string | undefined;
    for (let page = 0; page < 10; page++) {
      const listParams: {
        status: "paid";
        created: {gte: number};
        limit: number;
        starting_after?: string;
      } = {
        status: "paid",
        created: {gte: createdGte},
        limit: 100,
      };
      if (startingAfter) listParams.starting_after = startingAfter;
      const list = await stripe.invoices.list(listParams);
      for (const invoice of list.data) {
        const invoiceFields: StripePaidInvoiceFields = {
          id: invoice.id,
          number: invoice.number,
          status: invoice.status,
          amount_remaining: invoice.amount_remaining,
          customer: invoice.customer,
          customer_email: invoice.customer_email,
          metadata: invoice.metadata as Record<string, string> | null,
          hosted_invoice_url: invoice.hosted_invoice_url,
          created: invoice.created,
        };
        const itemRef = await findGuestItemRefForStripeInvoice(
          db,
          invoiceFields,
          entries,
        );
        if (!itemRef) {
          summary.unmatchedStripe++;
          if (summary.unmatchedInvoiceIds.length < 40) {
            summary.unmatchedInvoiceIds.push(invoice.id);
          }
          continue;
        }
        if (filterGuestId && !itemRef.path.includes(`/${filterGuestId}/`)) {
          continue;
        }
        const result = await applyStripePaidInvoiceToGuest(
          itemRef,
          invoiceFields,
        );
        const guestIdFromPath = itemRef.parent.id;
        if (result.updated) {
          summary.updated++;
          if (!summary.updatedGuestIds.includes(guestIdFromPath)) {
            summary.updatedGuestIds.push(guestIdFromPath);
          }
        } else if (result.alreadyPaid) {
          summary.alreadyPaid++;
        }
      }
      if (!list.has_more || list.data.length === 0) break;
      startingAfter = list.data[list.data.length - 1].id;
    }

    logger.info("reconcileStripePaidInvoicesHttp done", summary);
    res.status(200).json(summary);
  } catch (err) {
    logger.error("reconcileStripePaidInvoicesHttp", {err});
    res.status(500).json({
      error: err instanceof Error ?
        err.message :
        "Stripe paid-invoice reconcile failed.",
    });
  }
});

/**
 * Flatten a Stripe Invoice into a plain JSON object safe for Firestore / UI.
 * @param {Record<string, unknown>} invoice Stripe invoice-like object.
 * @return {Record<string, unknown>} Plain JSON representation.
 */
function stripeInvoiceToJson(
  invoice: Record<string, unknown>
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(invoice)) as Record<string, unknown>;
}

/**
 * Build a display/import row from a Stripe Invoice (one invoice = one JSON).
 * @param {Record<string, unknown>} invoice Stripe invoice-like object.
 * @return {Record<string, unknown>} Import document fields.
 */
function stripeInvoiceImportFields(
  invoice: Record<string, unknown>
): Record<string, unknown> {
  const meta = (invoice.metadata || {}) as Record<string, string>;
  const customerRaw = invoice.customer;
  let customerId = "";
  let customerNameFromObj = "";
  if (typeof customerRaw === "string") {
    customerId = customerRaw;
  } else if (customerRaw && typeof customerRaw === "object") {
    const cust = customerRaw as Record<string, unknown>;
    customerId = String(cust.id || "").trim();
    if (!cust.deleted) {
      customerNameFromObj = String(cust.name || "").trim();
    }
  }
  let customerName = String(invoice.customer_name || "").trim();
  if (!customerName) customerName = customerNameFromObj;
  return {
    id: String(invoice.id || "").trim(),
    number: invoice.number != null ? String(invoice.number) : null,
    status: invoice.status != null ? String(invoice.status) : null,
    currency: invoice.currency != null ? String(invoice.currency) : null,
    total: invoice.total ?? null,
    amount_due: invoice.amount_due ?? null,
    amount_paid: invoice.amount_paid ?? null,
    amount_remaining: invoice.amount_remaining ?? null,
    customer: customerId || null,
    customer_email: invoice.customer_email != null ?
      String(invoice.customer_email) :
      null,
    customer_name: customerName || null,
    hosted_invoice_url: invoice.hosted_invoice_url != null ?
      String(invoice.hosted_invoice_url) :
      null,
    invoice_pdf: invoice.invoice_pdf != null ?
      String(invoice.invoice_pdf) :
      null,
    created: invoice.created ?? null,
    due_date: invoice.due_date ?? null,
    guestId: String(meta.guestId || "").trim() || null,
    stripe: stripeInvoiceToJson(invoice),
  };
}

/**
 * Import Stripe invoices into Firestore (one invoice = one JSON doc) and
 * return them for the Finances Invoices table.
 * POST JSON: { lookbackDays?: number } (default 365, max 730; 0 = all).
 * Writes: tbs/Invoices/items/{invoiceId}
 */
export const importStripeInvoicesHttp = onRequest({
  secrets: [stripeSecretParam],
  timeoutSeconds: 300,
  invoker: "public",
  cors: true,
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({error: "Method not allowed"});
    return;
  }

  const stripeSecret = String(stripeSecretParam.value() || "").trim();
  if (!stripeSecret) {
    res.status(500).json({
      error: "Missing STRIPE_SECRET_KEY in functions environment.",
    });
    return;
  }
  const stripe = new Stripe(stripeSecret);
  const body = (req.body || {}) as Record<string, unknown>;
  const lookbackDaysRaw = Number(body.lookbackDays);
  const lookbackDays = Number.isFinite(lookbackDaysRaw) ?
    Math.min(Math.max(Math.floor(lookbackDaysRaw), 0), 730) :
    365;
  const createdGte = lookbackDays > 0 ?
    Math.floor(Date.now() / 1000) - (lookbackDays * 86400) :
    undefined;

  const db = getFirestore();
  const itemsCol = db.collection("tbs").doc("Invoices").collection("items");
  const invoices: Record<string, unknown>[] = [];
  let imported = 0;
  let startingAfter: string | undefined;

  try {
    for (let page = 0; page < 20; page++) {
      const listParams: {
        limit: number;
        expand: string[];
        created?: {gte: number};
        starting_after?: string;
      } = {
        limit: 100,
        expand: ["data.customer"],
      };
      if (createdGte != null) {
        listParams.created = {gte: createdGte};
      }
      if (startingAfter) listParams.starting_after = startingAfter;
      const list = await stripe.invoices.list(listParams);
      for (const invoice of list.data) {
        const fields = stripeInvoiceImportFields(
          invoice as unknown as Record<string, unknown>
        );
        const docId = String(fields.id || "").trim();
        if (!docId) continue;
        await itemsCol.doc(docId).set({
          ...fields,
          importedAt: FieldValue.serverTimestamp(),
        }, {merge: true});
        imported++;
        invoices.push(fields);
      }
      if (!list.has_more || list.data.length === 0) break;
      startingAfter = list.data[list.data.length - 1].id;
    }

    invoices.sort((a, b) => {
      const ac = Number(a.created || 0);
      const bc = Number(b.created || 0);
      return bc - ac;
    });

    const summary = {
      ok: true,
      imported,
      lookbackDays,
      invoices,
    };
    logger.info("importStripeInvoicesHttp done", {
      imported,
      lookbackDays,
      count: invoices.length,
    });
    res.status(200).json(summary);
  } catch (err) {
    logger.error("importStripeInvoicesHttp", {err});
    res.status(500).json({
      error: err instanceof Error ?
        err.message :
        "Stripe invoice import failed.",
    });
  }
});

/**
 * Guest workflow: send invitation HTML from tbs/Snippets as Registration@…
 * using server-side Gmail OAuth (refresh token). Sets Invited=Yes + log line.
 * Expects JSON: { guestId }.
 */
export const sendGuestInviteHttp = onRequest({
  secrets: [
    gmailSendClientIdParam,
    gmailSendClientSecretParam,
    gmailSendRefreshTokenParam,
    gmailSendFromParam,
  ],
  invoker: "public",
  cors: true,
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({error: "Method not allowed"});
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const guestId = String(body.guestId || "").trim();
  if (!guestId) {
    res.status(400).json({error: "Missing guestId."});
    return;
  }

  const fromAddress = String(gmailSendFromParam.value() || "").trim();
  if (!fromAddress || !fromAddress.includes("@")) {
    res.status(500).json({
      error: "Missing or invalid GMAIL_SEND_FROM secret.",
    });
    return;
  }

  const db = getFirestore();
  const itemRef = db
    .collection("tbs")
    .doc("Guests")
    .collection(guestId)
    .doc("item");

  try {
    const snap = await itemRef.get();
    if (!snap.exists) {
      res.status(404).json({error: "Guest item not found."});
      return;
    }
    const data = snap.data() || {};
    if (!guestInviteAllowed(data)) {
      res.status(400).json({
        error: "Invite is only available when Read is Yes and Invited is No.",
      });
      return;
    }

    const email = pickGuestEmail(data);
    if (
      !email ||
      /[\r\n]/.test(email) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      res.status(400).json({error: "Guest has no valid email."});
      return;
    }

    const htmlTemplate = await loadGuestInvitationHtml(db);
    if (!String(htmlTemplate).trim()) {
      res.status(500).json({
        error: "Guest invitation template is empty in tbs/Snippets.",
      });
      return;
    }

    const firstName = String(
      data.Name || data.name || data["First name"] || data.firstName || "",
    ).trim();
    const eventLabel = await loadCurrentEventLabel(db);
    const subject = (eventLabel ? eventLabel + " - Invitation" : "Invitation")
      .replace(/[\r\n]/g, " ");
    const html = String(htmlTemplate)
      .split("{{first_name}}")
      .join(escapeHtml(firstName))
      .split("{{Current event}}")
      .join(escapeHtml(eventLabel));

    const accessToken = await refreshGmailSendAccessToken();
    await sendGmailHtmlMessage(accessToken, {
      from: fromAddress,
      to: email,
      subject,
      html,
    });

    const inviteLogLine = guestLogInvitationEmailedLine();
    const invitedDate = formatGuestInvoicedDateDisplay(new Date());
    await itemRef.set({
      "Invited": "Yes",
      "Invited date": invitedDate,
      "Log": FieldValue.arrayUnion(inviteLogLine),
    }, {merge: true});

    logger.info("sendGuestInviteHttp ok", {
      guestId,
      to: email,
      from: fromAddress,
      invitedDate,
    });

    res.status(200).json({
      ok: true,
      guestId,
      to: email,
      from: fromAddress,
      invitedDate,
      message: firstName ?
        "Invite is sent to " + firstName :
        "Invite is sent.",
    });
  } catch (err) {
    logger.error("sendGuestInviteHttp failed", {guestId, err});
    res.status(500).json({
      error: err instanceof Error ?
        err.message :
        "Failed to send invitation.",
    });
  }
});

/**
 * Speaker workflow: send formal invitation HTML from
 * tbs/Snippets.Speakerinvitation as info@… using server-side Gmail OAuth
 * (GMAIL_SPEAKER_SEND_* secrets).
 * Sets Status/inviteStatus to Invited + Speaker log line.
 * Expects JSON: { speakerId }.
 * Guest invite path (sendGuestInviteHttp) is unchanged.
 */
export const sendSpeakerInviteHttp = onRequest({
  secrets: [
    gmailSpeakerSendClientIdParam,
    gmailSpeakerSendClientSecretParam,
    gmailSpeakerSendRefreshTokenParam,
    gmailSpeakerSendFromParam,
  ],
  invoker: "public",
  cors: true,
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({error: "Method not allowed"});
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const speakerId = String(body.speakerId || "").trim();
  if (!speakerId) {
    res.status(400).json({error: "Missing speakerId."});
    return;
  }

  const fromAddress = String(gmailSpeakerSendFromParam.value() || "").trim();
  if (!fromAddress || !fromAddress.includes("@")) {
    res.status(500).json({
      error: "Missing or invalid GMAIL_SPEAKER_SEND_FROM secret.",
    });
    return;
  }

  const db = getFirestore();
  const itemRef = db
    .collection("tbs")
    .doc("Speakers")
    .collection(speakerId)
    .doc("item");

  try {
    const snap = await itemRef.get();
    if (!snap.exists) {
      res.status(404).json({error: "Speaker item not found."});
      return;
    }
    const data = snap.data() || {};
    if (!speakerFormalInviteAllowed(data)) {
      res.status(400).json({
        error: "Formal invite is only available when Status is Confirmed.",
      });
      return;
    }

    const email = pickSpeakerEmail(data);
    if (
      !email ||
      /[\r\n]/.test(email) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      res.status(400).json({
        error: "Speaker has no valid email in tbs/Speakers email field.",
      });
      return;
    }

    const template = await loadSpeakerInvitationFromSnippets(db);
    const htmlTemplate = String(template.html || "").trim();
    if (!htmlTemplate) {
      res.status(500).json({
        error: "Speaker invitation template is empty in tbs/Snippets.",
      });
      return;
    }

    const firstName = pickSpeakerFirstName(data);
    const eventLabel = await loadCurrentEventLabel(db);
    const subject = (eventLabel ?
      eventLabel + " - Speaker invitation" :
      "Speaker invitation").replace(/[\r\n]/g, " ");
    const html = htmlTemplate
      .split("{{Event}}")
      .join(escapeHtml(eventLabel))
      .split("{{Name}}")
      .join(escapeHtml(firstName));

    const accessToken = await refreshGmailSpeakerSendAccessToken();
    await sendGmailHtmlMessage(accessToken, {
      from: fromAddress,
      to: email,
      subject,
      html,
    });

    const inviteLogLine = speakerLogFormalInviteSentLine();
    const invitedDate = formatGuestInvoicedDateDisplay(new Date());
    await itemRef.set({
      "Status": "Invited",
      "inviteStatus": "Invited",
      "invitedDate": invitedDate,
      "Invited date": invitedDate,
      "Speaker log": FieldValue.arrayUnion(inviteLogLine),
    }, {merge: true});

    logger.info("sendSpeakerInviteHttp ok", {
      speakerId,
      to: email,
      from: fromAddress,
      invitedDate,
    });

    res.status(200).json({
      ok: true,
      speakerId,
      to: email,
      from: fromAddress,
      invitedDate,
      logLine: inviteLogLine,
      message: firstName ?
        "Formal invite sent to " + firstName :
        "Formal invite sent.",
    });
  } catch (err) {
    logger.error("sendSpeakerInviteHttp failed", {speakerId, err});
    res.status(500).json({
      error: err instanceof Error ?
        err.message :
        "Failed to send speaker invitation.",
    });
  }
});

/**
 * Upload content image via Admin SDK to avoid client Storage rule issues.
 * Expects JSON: { docId, fileName, contentType, dataBase64 }.
 */
export const uploadContentImageHttp = onRequest({
  serviceAccount: "tbs-app-e2062@appspot.gserviceaccount.com",
  invoker: "public",
  cors: true,
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({error: "Method not allowed"});
    return;
  }

  try {
    const slugPart = (input: unknown): string => {
      let t = String(input ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\s/]+/g, "-")
        .replace(/[^a-z0-9-]+/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      if (!t) t = "x";
      return t.slice(0, 120);
    };
    const body = (req.body || {}) as Record<string, unknown>;
    const docId = String(body.docId || "").trim();
    const eventRaw = body.event;
    const nameRaw = body.name;
    const fileNameRaw = String(body.fileName || "image").trim();
    const contentTypeRaw = String(body.contentType || "image/jpeg").trim();
    const dataBase64Raw = String(body.dataBase64 || "").trim();

    if (!docId) {
      res.status(400).json({error: "Missing docId."});
      return;
    }
    if (!dataBase64Raw) {
      res.status(400).json({error: "Missing dataBase64."});
      return;
    }

    const safeDocId = docId.replace(/[^a-zA-Z0-9_-]+/g, "");
    if (!safeDocId) {
      res.status(400).json({error: "Invalid docId."});
      return;
    }
    const safeContentType =
      /^[a-z]+\/[a-z0-9.+-]+$/i.test(contentTypeRaw) ?
        contentTypeRaw :
        "image/jpeg";

    /**
     * Stable object name under thumbnails folder (matches Airtable sync).
     * @param {string} contentType MIME type.
     * @param {string} uploadedName Original filename fallback.
     * @return {string} e.g. `image.png`.
     */
    const imageBasename = (
      contentType: string,
      uploadedName: string,
    ): string => {
      const ct = String(contentType || "").toLowerCase();
      if (ct.includes("png")) return "image.png";
      if (ct.includes("webp")) return "image.webp";
      if (ct.includes("gif")) return "image.gif";
      if (ct.includes("jpeg") || ct.includes("jpg")) return "image.jpg";
      const fn = String(uploadedName || "").toLowerCase();
      const m = fn.match(/\.([a-z0-9]+)$/i);
      if (m) return `image.${m[1].toLowerCase()}`;
      return "image.jpg";
    };
    const base64 = dataBase64Raw.includes(",") ?
      dataBase64Raw.split(",").pop() || "" :
      dataBase64Raw;
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) {
      res.status(400).json({error: "Invalid image payload."});
      return;
    }

    const bucket = getStorage().bucket("tbs-app-e2062.firebasestorage.app");
    const eventStr = Array.isArray(eventRaw) ?
      eventRaw.filter(Boolean).join("-") :
      String(eventRaw || "");
    const nameStr = String(nameRaw || "");
    const eventPart = slugPart(eventStr);
    const namePart = slugPart(nameStr);
    const slugBase = `${eventPart}-${namePart}`.replace(/^-+|-+$/g, "");
    const slug = slugBase && slugBase !== "-" ?
      slugBase :
      slugPart(safeDocId || "content");
    const thumbPrefix = `TBS/thumbnails/${slug}/`;
    const objectName = imageBasename(safeContentType, fileNameRaw);
    const objectPath = `${thumbPrefix}${objectName}`;

    const [existingInFolder] = await bucket.getFiles({prefix: thumbPrefix});
    for (const existing of existingInFolder) {
      const n = existing.name || "";
      if (!n.startsWith(thumbPrefix)) continue;
      const base = n.slice(thumbPrefix.length);
      if (!/^image\.[a-z0-9]+$/i.test(base)) continue;
      try {
        await existing.delete({ignoreNotFound: true});
      } catch (delErr) {
        logger.warn("uploadContentImageHttp: remove old image", {
          name: n,
          err: delErr,
        });
      }
    }

    const file = bucket.file(objectPath);
    const downloadToken = randomUUID();
    await file.save(bytes, {
      metadata: {
        contentType: safeContentType,
        metadata: {
          firebaseStorageDownloadTokens: downloadToken,
        },
      },
      resumable: false,
    });
    const bucketName = bucket.name;
    const encodedPath = encodeURIComponent(objectPath);
    const downloadUrl =
      `https://firebasestorage.googleapis.com/v0/b/${bucketName}` +
      `/o/${encodedPath}?alt=media&token=${downloadToken}`;

    logger.info("uploadContentImageHttp ok", {
      docId: safeDocId,
      path: objectPath,
      downloadUrl: downloadUrl,
      size: bytes.length,
      contentType: safeContentType,
    });
    res.status(200).json({
      ok: true,
      path: objectPath,
      downloadUrl: downloadUrl,
    });
  } catch (err) {
    logger.error("uploadContentImageHttp failed", {err});
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to upload image.",
    });
  }
});

/**
 * Slug for guest id segments (event + first + last name).
 * @param {unknown} input Raw string.
 * @return {string} Alphanumeric slug segment.
 */
function registrationSlugPart(input: unknown): string {
  let t = String(input ?? "")
    .trim()
    .replace(/[\s/]+/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "");
  if (!t) t = "x";
  return t.slice(0, 80);
}

/**
 * Builds base guest document id: event + first + last (no separators).
 * @param {string} event Current event label.
 * @param {string} firstName Guest first name.
 * @param {string} lastName Guest last name.
 * @return {string} Firestore subcollection id.
 */
function buildRegistrationGuestId(
  event: string,
  firstName: string,
  lastName: string,
): string {
  const ev = registrationSlugPart(event);
  const first = registrationSlugPart(firstName);
  const last = registrationSlugPart(lastName);
  const id = `${ev}${first}${last}`.slice(0, 150);
  return id || "guest";
}

/**
 * YYYY-MM-DD for Application date.
 * @param {Date} date Submit timestamp.
 * @return {string} Date string.
 */
function formatApplicationDate(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Public registration: writes `tbs/Guests/{guestId}/item` and updates manifest.
 * Expects JSON body with form fields (no reCAPTCHA).
 */
export const submitRegistrationHttp = onRequest({
  invoker: "public",
  cors: true,
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({error: "Method not allowed"});
    return;
  }

  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const email = String(body.email || "").trim();
    const emailConfirm = String(body.emailConfirm || "").trim();
    const cityRegion = String(body.cityRegion || "").trim();
    const country = String(body.country || "").trim();
    const employer1 = String(body.employer1 || "").trim();
    const employer2 = String(body.employer2 || "").trim();
    const trainingLevel = String(body.trainingLevel || "").trim();
    const veryBriefBio = String(body.veryBriefBio || "").trim();
    const pastTbs = String(body.pastTbs || "").trim();

    const baseSpeciality = Array.isArray(body.baseSpeciality) ?
      body.baseSpeciality.map((v) => String(v || "").trim()).filter(Boolean) :
      [];
    const clinicalContext = Array.isArray(body.clinicalContext) ?
      body.clinicalContext.map((v) => String(v || "").trim()).filter(Boolean) :
      [];

    if (!firstName || !lastName) {
      res.status(400).json({error: "First and last name are required."});
      return;
    }
    if (!email || !email.includes("@")) {
      res.status(400).json({error: "A valid email is required."});
      return;
    }
    if (email !== emailConfirm) {
      res.status(400).json({error: "Email addresses must match."});
      return;
    }
    if (!cityRegion || !country || !employer1) {
      res.status(400).json({
        error: "City/region, country, and employer 1 are required.",
      });
      return;
    }
    if (!baseSpeciality.length) {
      res.status(400).json({
        error: "Select at least one base medical speciality.",
      });
      return;
    }
    if (!trainingLevel) {
      res.status(400).json({error: "Level of training is required."});
      return;
    }
    if (!clinicalContext.length) {
      res.status(400).json({error: "Select at least one clinical context."});
      return;
    }
    if (pastTbs !== "Yes" && pastTbs !== "No") {
      res.status(400).json({
        error: "Please indicate whether you have attended TBS in the past.",
      });
      return;
    }

    const db = getFirestore();
    const event = "TBS27";
    const submittedAt = new Date();
    const applicationDate = formatApplicationDate(submittedAt);

    const parentRef = db.collection("tbs").doc("Guests");
    const baseGuestId = buildRegistrationGuestId(event, firstName, lastName);
    let guestId = baseGuestId;
    let suffix = 0;
    let itemSnap = await parentRef.collection(guestId).doc("item").get();
    while (itemSnap.exists) {
      suffix += 1;
      guestId = `${baseGuestId}${suffix}`.slice(0, 150);
      itemSnap = await parentRef.collection(guestId).doc("item").get();
    }
    const guestsCol = parentRef.collection(guestId);

    const itemPayload: Record<string, unknown> = {
      "Name": firstName,
      "Last Name": lastName,
      "E-mail": email,
      "City/region": cityRegion,
      "Country": country,
      "Employer 1": employer1,
      "Employer 2": employer2,
      "Base medical speciality": baseSpeciality,
      "Level of Training": trainingLevel,
      "Clinical context": clinicalContext,
      "Brief bio": veryBriefBio,
      "Past TBS?": pastTbs,
      "Application date": applicationDate,
      "Attended": false,
      "Briefed": "No",
      "CME sent": "No",
      "Event": event,
      "Invited": "No",
      "Invoiced": "No",
      "Paid": "No",
      "Read": "No",
      "Log": [guestLogApplicationReceivedLine()],
    };

    await guestsCol.doc("item").set(itemPayload, {merge: false});
    await parentRef.set(
      {guestIds: FieldValue.arrayUnion(guestId)},
      {merge: true},
    );

    logger.info("submitRegistrationHttp ok", {guestId, event, email});
    res.status(200).json({ok: true, guestId, event});
  } catch (err) {
    logger.error("submitRegistrationHttp failed", {err});
    res.status(500).json({
      error: err instanceof Error ?
        err.message :
        "Registration could not be saved.",
    });
  }
});
