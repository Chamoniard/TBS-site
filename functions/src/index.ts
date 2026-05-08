import {randomUUID} from "node:crypto";
import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import {initializeApp} from "firebase-admin/app";
import {FieldValue, getFirestore} from "firebase-admin/firestore";
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
const stripeInvoiceTemplateId = "inrtem_1TTPvLJh1HgAavTOwaRm4T4d";
const stripeInvoicePriceId = "price_1TTix9Jh1HgAavTOyUmwFqzv";

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
    await itemRef.set({
      "Invoiced": "Yes",
      "Paid": "No",
      "Stripe Invoice Id": finalizedInvoice.id,
      "Stripe Invoice Status": finalizedInvoice.status || "open",
      "Stripe Invoice Url": finalizedInvoice.hosted_invoice_url || "",
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
 * Upload content image via Admin SDK to avoid client Storage rule issues.
 * Expects JSON: { docId, fileName, contentType, dataBase64 }.
 */
export const uploadContentImageHttp = onRequest({
  serviceAccount: "tbs-app-e2062@appspot.gserviceaccount.com",
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
