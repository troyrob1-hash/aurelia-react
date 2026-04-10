// functions/index.js
"use strict";

const { onCall, HttpsError }    = require("firebase-functions/v2/https");
const { onDocumentWritten }     = require("firebase-functions/v2/firestore");
const { onSchedule }            = require("firebase-functions/v2/scheduler");
const admin                     = require("firebase-admin");
const { v4: uuid }              = require("uuid");
const jwt                       = require("jsonwebtoken");
const jwksClient                = require("jwks-rsa");

admin.initializeApp();
const db = admin.firestore();

const POOL_ID        = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID      = process.env.COGNITO_CLIENT_ID;
const COGNITO_REGION = "us-east-2";
const COGNITO_ISSUER = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${POOL_ID}`;


// ============================================================
// COGNITO TOKEN VERIFICATION
// ============================================================
const client = jwksClient({
  jwksUri: `${COGNITO_ISSUER}/.well-known/jwks.json`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600000,
});

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyCognitoToken(idToken) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      idToken,
      getSigningKey,
      { issuer: COGNITO_ISSUER, algorithms: ["RS256"] },
      (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      }
    );
  });
}


// ============================================================
// HELPER: write an audit event
// ============================================================
async function writeAuditLog(orgId, actor, action, resource, before = null, after = null) {
  const eventId = uuid();
  await db
    .collection("orgs").doc(orgId)
    .collection("auditLog").doc(eventId)
    .set({
      eventId, orgId, actor, action,
      resourceType: resource.type,
      resourceId:   resource.id,
      locationId:   resource.locationId ?? null,
      before, after,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

const SYSTEM_ACTOR = { uid: "system", email: "system@aurelia-fms", displayName: "System", ip: null, userAgent: null };


// ============================================================
// CALLABLE: mintFirebaseToken
// Verifies Cognito ID token and returns a Firebase custom token
// ============================================================
exports.mintFirebaseToken = onCall(
  { invoker: "public" },
  async (request) => {
    const { idToken } = request.data;
    if (!idToken) {
      throw new HttpsError("invalid-argument", "Missing idToken");
    }
    try {
      const decoded = await verifyCognitoToken(idToken);

    const uid = decoded.sub;
    const email = decoded.email || "";
    const tenantId = decoded["custom:tenantId"] || "fooda";
    const role = decoded["custom:role"] || "viewer";
    const name = decoded["custom:managerName"] || decoded.name || email;

    // Create custom token with claims embedded
    const firebaseToken = await admin.auth().createCustomToken(uid, {
      "custom:tenantId": tenantId,
      "custom:role": role,
      "custom:name": name,
      email,
    });

    return { firebaseToken };
  } catch (err) {
    console.error("mintFirebaseToken error:", err);
    throw new HttpsError("unauthenticated", "Invalid Cognito token: " + err.message);
  }
});


// ============================================================
// TRIGGER: audit user writes
// ============================================================
exports.auditUserWrite = onDocumentWritten("orgs/{orgId}/users/{uid}", async (event) => {
  const { orgId, uid } = event.params;
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after  = event.data.after.exists  ? event.data.after.data()  : null;

  let action = "user.updated";
  if (!before)                              action = "user.created";
  else if (before.active && !after?.active) action = "user.deactivated";
  else if (!before.active && after?.active) action = "user.activated";
  else if (before.role !== after?.role)     action = "user.role_changed";

  const clean = (doc) => {
    if (!doc) return null;
    const { lastLoginIp, cognitoToken, ...rest } = doc;
    return rest;
  };

  await writeAuditLog(orgId, SYSTEM_ACTOR, action, { type: "user", id: uid }, clean(before), clean(after));
});


// ============================================================
// TRIGGER: audit location writes
// ============================================================
exports.auditLocationWrite = onDocumentWritten("orgs/{orgId}/locations/{locationId}", async (event) => {
  const { orgId, locationId } = event.params;
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after  = event.data.after.exists  ? event.data.after.data()  : null;

  let action = "location.updated";
  if (!before)                              action = "location.created";
  else if (before.active && !after?.active) action = "location.deactivated";

  await writeAuditLog(orgId, SYSTEM_ACTOR, action, { type: "location", id: locationId }, before, after);
});


// ============================================================
// TRIGGER: audit API key writes
// ============================================================
exports.auditApiKeyWrite = onDocumentWritten("orgs/{orgId}/apiKeys/{keyId}", async (event) => {
  const { orgId, keyId } = event.params;
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after  = event.data.after.exists  ? event.data.after.data()  : null;

  let action = "apiKey.created";
  if (before && !after?.active && before.active) action = "apiKey.revoked";
  else if (before) action = "apiKey.updated";

  const safeAfter = after ? { keyId: after.keyId, label: after.label, service: after.service, active: after.active } : null;

  await writeAuditLog(orgId, SYSTEM_ACTOR, action, { type: "apiKey", id: keyId }, null, safeAfter);
});


// ============================================================
// CALLABLE: inviteUser
// ============================================================
exports.inviteUser = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const { orgId, email, displayName, role, locationIds = [] } = request.data;
  const callerUid = request.auth.uid;

  const validRoles = ["admin", "director", "manager"];
  if (!orgId || !email || !role || !validRoles.includes(role)) {
    throw new HttpsError("invalid-argument", "Missing or invalid fields.");
  }

  const callerSnap = await db.collection("orgs").doc(orgId).collection("users").doc(callerUid).get();
  if (!callerSnap.exists || callerSnap.data().role !== "admin" || !callerSnap.data().active) {
    throw new HttpsError("permission-denied", "Only admins can invite users.");
  }

  const existing = await db.collection("orgs").doc(orgId).collection("users")
    .where("email", "==", email).limit(1).get();
  if (!existing.empty) throw new HttpsError("already-exists", "A user with this email already exists.");

  try {
    const AWS     = require("aws-sdk");
    const cognito = new AWS.CognitoIdentityServiceProvider({ region: "us-east-2" });

    const cognitoRes = await cognito.adminCreateUser({
      UserPoolId:        POOL_ID,
      Username:          email,
      MessageAction:     "SUPPRESS",
      UserAttributes: [
        { Name: "email",          Value: email },
        { Name: "email_verified", Value: "true" },
        { Name: "name",           Value: displayName },
        { Name: "custom:orgId",   Value: orgId },
      ],
    }).promise();

    const newUid = cognitoRes.User.Username;
    const now    = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("orgs").doc(orgId).collection("users").doc(newUid).set({
      uid: newUid, orgId, email, displayName, role,
      permissionOverrides: {
        canExportData: null, canApproveOrders: null, canViewFinancials: null,
        canManageUsers: null, canManageLocations: null, canManageAPIKeys: null,
        approvalLimitUSD: null,
      },
      active: true, mfaEnabled: false, ssoOnly: false,
      lastLoginAt: null, lastLoginIp: null,
      inviteStatus: "pending",
      invitedBy: callerUid, invitedAt: now,
      deactivatedAt: null, deactivatedBy: null,
      createdAt: now, updatedAt: now,
    });

    const batch = db.batch();
    for (const locationId of locationIds) {
      const ref = db.collection("orgs").doc(orgId).collection("userLocations").doc(`${newUid}_${locationId}`);
      batch.set(ref, { uid: newUid, locationId, orgId, role, assignedBy: callerUid, assignedAt: now });
    }
    await batch.commit();

    const caller = callerSnap.data();
    await writeAuditLog(orgId,
      { uid: callerUid, email: caller.email, displayName: caller.displayName, ip: request.rawRequest?.ip ?? null, userAgent: null },
      "user.invited", { type: "user", id: newUid },
      null, { email, role, locationIds }
    );

    return { success: true, uid: newUid };
  } catch (err) {
    console.error("inviteUser error:", err);
    throw new HttpsError("internal", err.message);
  }
});


// ============================================================
// CALLABLE: deactivateUser
// ============================================================
exports.deactivateUser = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const { orgId, targetUid } = request.data;
  const callerUid = request.auth.uid;

  const callerSnap = await db.collection("orgs").doc(orgId).collection("users").doc(callerUid).get();
  if (!callerSnap.exists || callerSnap.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can deactivate users.");
  }
  if (callerUid === targetUid) {
    throw new HttpsError("failed-precondition", "You cannot deactivate yourself.");
  }

  const AWS     = require("aws-sdk");
  const cognito = new AWS.CognitoIdentityServiceProvider({ region: "us-east-2" });

  await cognito.adminDisableUser({ UserPoolId: POOL_ID, Username: targetUid }).promise();

  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection("orgs").doc(orgId).collection("users").doc(targetUid).update({
    active: false, deactivatedAt: now, deactivatedBy: callerUid, updatedAt: now,
  });

  await admin.auth().revokeRefreshTokens(targetUid);

  const caller = callerSnap.data();
  await writeAuditLog(orgId,
    { uid: callerUid, email: caller.email, displayName: caller.displayName, ip: null, userAgent: null },
    "user.deactivated", { type: "user", id: targetUid },
    null, { deactivatedBy: callerUid }
  );

  return { success: true };
});


// ============================================================
// SCHEDULED: clean up expired sessions every hour
// ============================================================
exports.cleanExpiredSessions = onSchedule("every 60 minutes", async () => {
  const now      = admin.firestore.Timestamp.now();
  const orgsSnap = await db.collection("orgs").where("active", "==", true).get();

  for (const orgDoc of orgsSnap.docs) {
    const expired = await db
      .collection("orgs").doc(orgDoc.id)
      .collection("sessions")
      .where("expiresAt", "<", now)
      .where("revokedAt", "==", null)
      .get();

    const batch = db.batch();
    expired.docs.forEach(d => batch.update(d.ref, { revokedAt: now, revokedBy: "system" }));
    await batch.commit();
  }
});


// ============================================================
// HELPER: generate secure temp password
// ============================================================

// ============================================================
// CALLABLE: submitAccessRequest
// Public — accepts access requests from unauthenticated visitors
// ============================================================
exports.submitAccessRequest = onCall(
  { invoker: "public" },
  async (request) => {
    const { name, email, message } = request.data || {};

    // Validate input
    if (typeof name !== "string" || typeof email !== "string") {
      throw new HttpsError("invalid-argument", "Name and email are required.");
    }

    const trimmedName  = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedMsg   = (typeof message === "string" ? message.trim() : "");

    if (!trimmedName || trimmedName.length > 100) {
      throw new HttpsError("invalid-argument", "Invalid name.");
    }
    if (!trimmedEmail || trimmedEmail.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      throw new HttpsError("invalid-argument", "Invalid email.");
    }
    if (trimmedMsg.length > 1000) {
      throw new HttpsError("invalid-argument", "Message too long.");
    }

    // Hardcoded to fooda for now — multi-tenant intake comes with the proper feature
    const tenantId = "fooda";

    // Capture metadata for review
    const ip        = request.rawRequest?.ip ?? null;
    const userAgent = request.rawRequest?.headers?.["user-agent"] ?? null;

    const requestId = uuid();
    await db
      .collection("tenants").doc(tenantId)
      .collection("accessRequests").doc(requestId)
      .set({
        requestId,
        tenantId,
        name:    trimmedName,
        email:   trimmedEmail,
        message: trimmedMsg,
        status:  "pending",
        ip,
        userAgent,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    return { success: true };
  }
);
function generateTempPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
// ============================================================
// CALLABLE: createAPIKey
// ============================================================
exports.createAPIKey = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const { orgId, label, service, rawKey, locationId } = request.data;
  const callerUid = request.auth.uid;

  if (!orgId || !label || !rawKey) {
    throw new HttpsError("invalid-argument", "orgId, label, and rawKey are required.");
  }

  const callerSnap = await db.collection("orgs").doc(orgId).collection("users").doc(callerUid).get();
  if (!callerSnap.exists || callerSnap.data().role !== "admin" || !callerSnap.data().active) {
    throw new HttpsError("permission-denied", "Only admins can create API keys.");
  }

  const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
  const smClient = new SecretManagerServiceClient();
  const projectId = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT;

  const keyId = uuid();
  const secretId = `apikey_${orgId}_${keyId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const maskedValue = "••••" + rawKey.slice(-4);

  // Create secret in Secret Manager
  try {
    await smClient.createSecret({
      parent: `projects/${projectId}`,
      secretId,
      secret: { replication: { automatic: {} } },
    });

    await smClient.addSecretVersion({
      parent: `projects/${projectId}/secrets/${secretId}`,
      payload: { data: Buffer.from(rawKey, "utf8") },
    });
  } catch (e) {
    console.error("Secret Manager error:", e);
    throw new HttpsError("internal", "Failed to store key securely.");
  }

  // Write metadata to Firestore
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection("orgs").doc(orgId).collection("apiKeys").doc(keyId).set({
    keyId,
    orgId,
    label: label.trim(),
    service: service || "other",
    locationId: locationId || null,
    maskedValue,
    secretId,
    active: true,
    lastUsedAt: null,
    createdAt: now,
    createdBy: callerUid,
  });

  const caller = callerSnap.data();
  await writeAuditLog(orgId,
    { uid: callerUid, email: caller.email, displayName: caller.displayName, ip: null, userAgent: null },
    "apikey.created", { type: "apiKey", id: keyId },
    null, { label: label.trim(), service: service || "other", locationId: locationId || null }
  );

  return { success: true, keyId, maskedValue };
});

// ============================================================
// CALLABLE: getAPIKeyValue
// ============================================================
exports.getAPIKeyValue = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const { orgId, keyId } = request.data;
  const callerUid = request.auth.uid;

  if (!orgId || !keyId) {
    throw new HttpsError("invalid-argument", "orgId and keyId are required.");
  }

  const callerSnap = await db.collection("orgs").doc(orgId).collection("users").doc(callerUid).get();
  if (!callerSnap.exists || callerSnap.data().role !== "admin" || !callerSnap.data().active) {
    throw new HttpsError("permission-denied", "Only admins can reveal API keys.");
  }

  const keySnap = await db.collection("orgs").doc(orgId).collection("apiKeys").doc(keyId).get();
  if (!keySnap.exists || !keySnap.data().active) {
    throw new HttpsError("not-found", "API key not found or has been revoked.");
  }

  const { secretId } = keySnap.data();
  const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
  const smClient = new SecretManagerServiceClient();
  const projectId = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT;

  try {
    const [version] = await smClient.accessSecretVersion({
      name: `projects/${projectId}/secrets/${secretId}/versions/latest`,
    });
    const rawKey = version.payload.data.toString("utf8");

    const caller = callerSnap.data();
    await writeAuditLog(orgId,
      { uid: callerUid, email: caller.email, displayName: caller.displayName, ip: null, userAgent: null },
      "apiKey.accessed", { type: "apiKey", id: keyId },
      null, null
    );

    return { rawKey };
  } catch (e) {
    console.error("Secret Manager error:", e);
    throw new HttpsError("internal", "Failed to retrieve key.");
  }
});

// ============================================================
// CALLABLE: revokeAPIKey
// ============================================================
exports.revokeAPIKey = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const { orgId, keyId } = request.data;
  const callerUid = request.auth.uid;

  if (!orgId || !keyId) {
    throw new HttpsError("invalid-argument", "orgId and keyId are required.");
  }

  const callerSnap = await db.collection("orgs").doc(orgId).collection("users").doc(callerUid).get();
  if (!callerSnap.exists || callerSnap.data().role !== "admin" || !callerSnap.data().active) {
    throw new HttpsError("permission-denied", "Only admins can revoke API keys.");
  }

  const keySnap = await db.collection("orgs").doc(orgId).collection("apiKeys").doc(keyId).get();
  if (!keySnap.exists) {
    throw new HttpsError("not-found", "API key not found.");
  }

  const keyData = keySnap.data();
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Mark inactive in Firestore
  await db.collection("orgs").doc(orgId).collection("apiKeys").doc(keyId).update({
    active: false,
    revokedAt: now,
    revokedBy: callerUid,
  });

  // Delete secret from Secret Manager (if it exists)
  if (keyData.secretId) {
    const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
    const smClient = new SecretManagerServiceClient();
    const projectId = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT;

    try {
      await smClient.deleteSecret({
        name: `projects/${projectId}/secrets/${keyData.secretId}`,
      });
    } catch (e) {
      // Secret may already be deleted — log but don't fail the revocation
      console.warn("Secret Manager cleanup warning:", e.message);
    }
  }

  const caller = callerSnap.data();
  await writeAuditLog(orgId,
    { uid: callerUid, email: caller.email, displayName: caller.displayName, ip: null, userAgent: null },
    "apikey.revoked", { type: "apiKey", id: keyId },
    { label: keyData.label, active: true }, { active: false, revokedBy: callerUid }
  );

  return { success: true };
});


// ============================================================
// SCHEDULED: process scheduled invoice payments
// Runs every hour. Finds invoices where scheduledPaymentDate <= today
// and flips them from Approved to Paid, writing to the P&L.
// ============================================================
exports.processScheduledPayments = onSchedule("every 60 minutes", async () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString().slice(0, 10);

  console.log(`Running scheduled payment processor for ${todayISO}`);

  // Find all tenants
  const tenantsSnap = await db.collection("tenants").get();

  for (const tenantDoc of tenantsSnap.docs) {
    const orgId = tenantDoc.id;

    // Find invoices scheduled for today or earlier that are still Approved
    const invoicesSnap = await db
      .collection("tenants").doc(orgId)
      .collection("invoices")
      .where("status", "==", "Approved")
      .where("scheduledPaymentDate", "<=", todayISO)
      .get();

    if (invoicesSnap.empty) continue;

    console.log(`Found ${invoicesSnap.size} scheduled invoices to process for ${orgId}`);

    for (const invDoc of invoicesSnap.docs) {
      const inv = invDoc.data();
      try {
        await invDoc.ref.update({
          status: "Paid",
          amountPaid: inv.amount,
          paidBy: "scheduled-payment-processor",
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          syncStatus: null,
          scheduledPaymentDate: admin.firestore.FieldValue.delete(),
        });

        // Write to audit log — this uses a 'system' actor since there's no user
        await writeAuditLog(orgId,
          { uid: "system", email: "scheduled-payment-processor@aurelia-fms", displayName: "Scheduled Payment Processor", ip: null, userAgent: null },
          "invoice.auto_paid",
          { type: "invoice", id: invDoc.id },
          { status: "Approved", scheduledPaymentDate: inv.scheduledPaymentDate },
          { status: "Paid", paidAt: todayISO }
        );

        console.log(`Auto-paid invoice ${invDoc.id} (${inv.vendor} · $${inv.amount})`);
      } catch (e) {
        console.error(`Failed to auto-pay invoice ${invDoc.id}:`, e);
      }
    }
  }

  console.log("Scheduled payment processor finished");
});


// ============================================================
// SCHEDULED: process recurring invoices
// Runs daily. Finds invoices with recurrence.nextDate <= today
// and creates a new invoice copy with the next scheduled date.
// ============================================================
exports.processRecurringInvoices = onSchedule("every 24 hours", async () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString().slice(0, 10);

  console.log(`Running recurring invoice processor for ${todayISO}`);

  const tenantsSnap = await db.collection("tenants").get();

  for (const tenantDoc of tenantsSnap.docs) {
    const orgId = tenantDoc.id;

    // Find invoices with recurrence.nextDate <= today that are still active
    const invoicesSnap = await db
      .collection("tenants").doc(orgId)
      .collection("invoices")
      .where("recurrence.active", "==", true)
      .where("recurrence.nextDate", "<=", todayISO)
      .get();

    if (invoicesSnap.empty) continue;

    console.log(`Found ${invoicesSnap.size} recurring invoices to process for ${orgId}`);

    for (const invDoc of invoicesSnap.docs) {
      const parent = invDoc.data();
      try {
        // Compute next date based on frequency
        const nextDate = computeNextRecurrenceDate(parent.recurrence.nextDate, parent.recurrence.frequency);
        const endDate = parent.recurrence.endDate;

        // Check if we've passed the end date
        const shouldContinue = !endDate || nextDate <= endDate;

        // Create the new child invoice (Pending status — requires human approval each cycle)
        const childData = {
          vendor: parent.vendor,
          vendorId: parent.vendorId,
          invoiceNum: `${parent.invoiceNum || 'REC'}-${parent.recurrence.nextDate}`,
          amount: parent.amount,
          amountPaid: 0,
          invoiceDate: parent.recurrence.nextDate,
          dueDate: parent.dueDate ? addDaysToDate(parent.recurrence.nextDate, daysBetween(parent.invoiceDate, parent.dueDate)) : null,
          glCode: parent.glCode || '',
          location: parent.location || '',
          periodKey: computePeriodKey(parent.recurrence.nextDate),
          notes: parent.notes || '',
          status: 'Pending',
          syncStatus: null,
          poNumber: parent.poNumber || '',
          recurrence: null,
          parentRecurringId: invDoc.id,
          createdBy: 'recurring-invoice-processor',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const childRef = await db
          .collection("tenants").doc(orgId)
          .collection("invoices")
          .add(childData);

        // Update the parent: advance nextDate, or deactivate if past endDate
        if (shouldContinue) {
          await invDoc.ref.update({
            "recurrence.nextDate": nextDate,
            "recurrence.lastGeneratedAt": admin.firestore.FieldValue.serverTimestamp(),
            "recurrence.lastGeneratedId": childRef.id,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          await invDoc.ref.update({
            "recurrence.active": false,
            "recurrence.endedAt": admin.firestore.FieldValue.serverTimestamp(),
            "recurrence.endReason": "reached end date",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        await writeAuditLog(orgId,
          { uid: "system", email: "recurring-invoice-processor@aurelia-fms", displayName: "Recurring Invoice Processor", ip: null, userAgent: null },
          "invoice.recurring_generated",
          { type: "invoice", id: childRef.id },
          null,
          { parentId: invDoc.id, amount: parent.amount, vendor: parent.vendor }
        );

        console.log(`Generated recurring invoice ${childRef.id} from parent ${invDoc.id}`);
      } catch (e) {
        console.error(`Failed to process recurring invoice ${invDoc.id}:`, e);
      }
    }
  }

  console.log("Recurring invoice processor finished");
});

// Helper: compute next recurrence date based on frequency
function computeNextRecurrenceDate(currentDate, frequency) {
  const d = new Date(currentDate + "T00:00:00");
  switch (frequency) {
    case "weekly":    d.setDate(d.getDate() + 7); break;
    case "biweekly":  d.setDate(d.getDate() + 14); break;
    case "monthly":   d.setMonth(d.getMonth() + 1); break;
    case "quarterly": d.setMonth(d.getMonth() + 3); break;
    case "yearly":    d.setFullYear(d.getFullYear() + 1); break;
    default:          d.setMonth(d.getMonth() + 1); // default to monthly
  }
  return d.toISOString().slice(0, 10);
}

function daysBetween(d1, d2) {
  if (!d1 || !d2) return 0;
  return Math.round((new Date(d2) - new Date(d1)) / 86400000);
}

function addDaysToDate(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function computePeriodKey(dateStr) {
  // YYYY-PMM-WN format
  const d = new Date(dateStr + "T00:00:00");
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const weekOfMonth = Math.ceil(d.getDate() / 7);
  return `${year}-P${month}-W${weekOfMonth}`;
}
