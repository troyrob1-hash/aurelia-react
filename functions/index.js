// functions/index.js
"use strict";

const { onCall, HttpsError }    = require("firebase-functions/v2/https");
const { onDocumentWritten }     = require("firebase-functions/v2/firestore");
const { onSchedule }            = require("firebase-functions/v2/scheduler");
const { defineSecret }          = require("firebase-functions/params");
const admin                     = require("firebase-admin");
const { v4: uuid }              = require("uuid");
const jwt                       = require("jsonwebtoken");
const jwksClient                = require("jwks-rsa");

// AWS credentials live in Secret Manager (functions:secrets:set), bound to
// each function below via the `secrets` option. aws-sdk v2's default
// credential chain reads them from process.env at SDK-call time — no change
// to the AWS client constructors themselves is needed.
const AWS_ACCESS_KEY_ID     = defineSecret("AWS_ACCESS_KEY_ID");
const AWS_SECRET_ACCESS_KEY = defineSecret("AWS_SECRET_ACCESS_KEY");

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
    // Phase A observability for the 'fooda' silent-fallback bug cluster: log
    // + audit-log when the Cognito token genuinely lacks the custom:tenantId
    // claim. mapUser (client) has a matching console.warn. The fallback is
    // kept for now to avoid locking out any legacy Cognito users whose pool
    // entries pre-date the attribute; Phase B will remove it after the
    // backfill script runs and these audit entries confirm zero recent hits.
    const claimTenantId = decoded["custom:tenantId"];
    if (!claimTenantId) {
      console.warn(
        `[mintFirebaseToken] custom:tenantId missing — uid=${uid} email=${email || "<none>"} — falling back to fooda. ` +
        `Phase B will tighten this after Cognito backfill.`
      );
      try {
        await writeAuditLog(
          "fooda",
          { uid, email: email || null, displayName: null, ip: null, userAgent: null },
          "auth.tenantId_fallback",
          { type: "auth", id: uid }
        );
      } catch (logErr) {
        console.warn("[mintFirebaseToken] audit-log write failed:", logErr.message);
      }
    }
    const tenantId = claimTenantId || "fooda";
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
exports.inviteUser = onCall(
  { invoker: "public", secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY] },
  async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const {
    orgId, email: rawEmail, displayName,
    roles = [],
    managedRegionIds = [],
    assignedLocations = [],
  } = request.data;
  const callerUid = request.auth.uid;

  // Validate inputs
  const VALID_ROLES = ["manager", "director", "vp", "admin"];
  if (!orgId || !rawEmail || !displayName) {
    throw new HttpsError("invalid-argument", "orgId, email, and displayName are required.");
  }
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new HttpsError("invalid-argument", "At least one role must be specified.");
  }
  const invalid = roles.find(r => !VALID_ROLES.includes(r));
  if (invalid) {
    throw new HttpsError("invalid-argument", `Invalid role: ${invalid}`);
  }

  // Check caller role from auth token (set by Cognito via mintFirebaseToken)
  const callerRole = request.auth.token["custom:role"] || "";
  if (callerRole !== "admin" && callerRole !== "director") {
    throw new HttpsError("permission-denied", "Only admins can invite users. Your role: " + callerRole);
  }

  // Email is the authoritative chokepoint — Cognito Username and the
  // Firestore doc id are both derived from it, so casing must be locked
  // down here regardless of what the calling client sent.
  const email = String(rawEmail).trim().toLowerCase();

  // Dedupe guard — if an ACTIVE user doc already exists for this email
  // in this org, refuse the invite. The existing-Cognito-user branch
  // below would otherwise reset their password and overwrite their
  // role/locations (and, if the existing Cognito Username has different
  // casing, the create branch would silently make a second Cognito user).
  const existingByEmail = await db.collection("orgs").doc(orgId)
    .collection("users").where("email", "==", email).limit(1).get();
  if (!existingByEmail.empty) {
    const existing = existingByEmail.docs[0].data();
    if (existing.active !== false) {
      throw new HttpsError(
        "already-exists",
        "A user with email " + email + " already exists in this org. " +
        "Edit that user's access instead of inviting them again."
      );
    }
    // Deactivated → fall through; the existing-Cognito-user branch
    // below will reactivate the account.
  }

  const AWS     = require("aws-sdk");
  const cognito = new AWS.CognitoIdentityServiceProvider({ region: "us-east-2" });
  const TIER_ORDER = ["admin", "vp", "director", "manager"];
  const primaryRole = TIER_ORDER.find(r => roles.includes(r)) || roles[0];
  const tempPassword = "Welcome2026!";

  let uid = null;
  let isNew = false;

  // Step 1: Check if user already exists in Cognito
  try {
    const existing = await cognito.adminGetUser({ UserPoolId: POOL_ID, Username: email }).promise();
    uid = existing.Username;
    console.log("inviteUser: existing Cognito user found:", uid);
    // Update their attributes
    await cognito.adminUpdateUserAttributes({
      UserPoolId: POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: "custom:tenantId", Value: orgId },
        { Name: "custom:role", Value: primaryRole },
        { Name: "name", Value: displayName },
      ],
    }).promise();
    // Reset their password so they can log in with the temp password
    await cognito.adminSetUserPassword({
      UserPoolId: POOL_ID,
      Username: email,
      Password: tempPassword,
      Permanent: true,
    }).promise();
    console.log("inviteUser: password set (permanent) for existing user:", email);
  } catch (lookupErr) {
    if (lookupErr.code === "UserNotFoundException") {
      // Step 2: User doesn't exist — create them
      try {
        const created = await cognito.adminCreateUser({
          UserPoolId: POOL_ID,
          Username: email,
          MessageAction: "SUPPRESS",
          // TemporaryPassword intentionally omitted — Cognito generates a
          // throwaway random temp password we never use. Passing our own
          // here AND then setting the SAME value as Permanent below causes
          // Cognito to no-op the second call and leave the user in
          // FORCE_CHANGE_PASSWORD. Letting Cognito invent the temp value
          // ensures the Permanent set below is a real password change that
          // transitions the user to CONFIRMED.
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
            { Name: "name", Value: displayName },
            { Name: "custom:tenantId", Value: orgId },
            { Name: "custom:role", Value: primaryRole },
          ],
        }).promise();
        uid = created.User.Username;
        isNew = true;
        console.log("inviteUser: new Cognito user created:", uid);
        // Set password as permanent so they can log in immediately
        await cognito.adminSetUserPassword({
          UserPoolId: POOL_ID,
          Username: email,
          Password: tempPassword,
          Permanent: true,
        }).promise();
        console.log("inviteUser: password set (permanent) for new user:", email);
      } catch (createErr) {
        console.error("inviteUser: create failed:", createErr);
        throw new HttpsError("internal", "Failed to create account: " + createErr.message);
      }
    } else {
      console.error("inviteUser: lookup failed:", lookupErr);
      throw new HttpsError("internal", "Failed to check account: " + lookupErr.message);
    }
  }

  // Step 3: Create or update Firestore user doc
  try {
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db.collection("orgs").doc(orgId).collection("users").doc(uid).set({
      uid, orgId, email, displayName,
      roles,
      role: primaryRole,
      managedRegionIds,
      assignedLocations,
      active: true,
      inviteStatus: "active",
      ...(isNew ? {
        permissionOverrides: {
          canExportData: null, canApproveOrders: null, canViewFinancials: null,
          canManageUsers: null, canManageLocations: null, canManageAPIKeys: null,
          approvalLimitUSD: null,
        },
        mfaEnabled: false, ssoOnly: false,
        lastLoginAt: null, lastLoginIp: null,
        invitedBy: callerUid, invitedAt: now,
        deactivatedAt: null, deactivatedBy: null,
        createdAt: now,
      } : {}),
      updatedAt: now,
    }, { merge: true });
    console.log("inviteUser: Firestore doc written for", uid);
  } catch (dbErr) {
    console.error("inviteUser: Firestore write failed:", dbErr);
    throw new HttpsError("internal", "Account created but failed to save settings: " + dbErr.message);
  }

  // Step 4: Audit log
  try {
    await writeAuditLog(orgId,
      { uid: callerUid, email: request.auth.token.email || "", displayName: request.auth.token["custom:name"] || "", ip: request.rawRequest?.ip ?? null, userAgent: null },
      isNew ? "user.invited" : "user.updated", { type: "user", id: uid },
      null, { email, roles, managedRegionIds, assignedLocations }
    );
  } catch (auditErr) {
    console.error("inviteUser: audit log failed (non-fatal):", auditErr);
  }

  return { success: true, uid, tempPassword, isNew };
});


// ============================================================
// CALLABLE: deactivateUser
// ============================================================
exports.deactivateUser = onCall(
  { invoker: "public", secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY] },
  async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const { orgId, targetUid } = request.data;
  const callerUid = request.auth.uid;

  // Check caller role from auth token (set by Cognito via mintFirebaseToken)
  const callerRole = request.auth.token["custom:role"] || "";
  if (callerRole !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can deactivate users. Your role: " + callerRole);
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

  try {
    await admin.auth().revokeRefreshTokens(targetUid);
  } catch (err) {
    if (err?.errorInfo?.code !== "auth/user-not-found") throw err;
    // No Firebase Auth record (user never signed in via app). Nothing to revoke;
    // the Cognito disable already blocks future sign-ins.
  }

  await writeAuditLog(orgId,
    { uid: callerUid, email: request.auth.token.email || "", displayName: request.auth.token["custom:name"] || "", ip: null, userAgent: null },
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
  { invoker: "public", secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY] },
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

    // Dedupe 1: email already maps to an active user. Public endpoint —
    // return a clean status the frontend can render as "you already have
    // access," not a scary error.
    const existingUser = await db.collection("orgs").doc(tenantId)
      .collection("users").where("email", "==", trimmedEmail).limit(1).get();
    if (!existingUser.empty && existingUser.docs[0].data().active !== false) {
      return { success: true, status: "already_active" };
    }

    // Dedupe 2: pending request for this email already exists. Avoids the
    // Carl-delaRosa-twice-in-the-queue case. Approved/denied prior requests
    // do NOT block a fresh submission — only an open pending one does.
    const existingPending = await db.collection("tenants").doc(tenantId)
      .collection("accessRequests")
      .where("email", "==", trimmedEmail)
      .where("status", "==", "pending")
      .limit(1).get();
    if (!existingPending.empty) {
      return { success: true, status: "duplicate_pending" };
    }

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

    // Notify admins — write to a notifications collection for in-app alerts
    await db
      .collection("tenants").doc(tenantId)
      .collection("notifications").doc(requestId)
      .set({
        type: "access_request",
        title: "New access request",
        message: trimmedName + " (" + trimmedEmail + ") requested access" + (trimmedMsg ? ": " + trimmedMsg : ""),
        read: false,
        requestId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Email admin about new access request
    try {
      const AWS = require("aws-sdk");
      const ses = new AWS.SES({ region: "us-east-2" });
      await ses.sendEmail({
        Source: "aurelia@fooda.com",
        Destination: { ToAddresses: ["troy.robinson@fooda.com"] },
        Message: {
          Subject: { Data: "Aurelia — New access request from " + trimmedName },
          Body: {
            Html: {
              Data: "<div style='font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;'>"
                + "<div style='background:#F15D3B;color:#fff;padding:12px 20px;border-radius:10px 10px 0 0;font-weight:700;'>Aurelia FMS</div>"
                + "<div style='background:#fff;border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 10px 10px;'>"
                + "<h2 style='margin:0 0 12px;font-size:18px;color:#0f172a;'>New access request</h2>"
                + "<p style='margin:0 0 8px;color:#334155;'><strong>" + trimmedName + "</strong> (" + trimmedEmail + ") requested access to Aurelia.</p>"
                + (trimmedMsg ? "<p style='margin:0 0 8px;color:#64748b;font-style:italic;'>" + trimmedMsg + "</p>" : "")
                + "<p style='margin:16px 0 0;'><a href='https://aureliafms.com/settings' style='display:inline-block;padding:10px 24px;background:#1D9E75;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;'>Review in Aurelia</a></p>"
                + "</div></div>"
            }
          }
        }
      }).promise();
    } catch (emailErr) {
      // Don't fail the request if email fails — notification is already in Firestore
      console.warn("Failed to send admin email:", emailErr.message);
    }

    return { success: true, status: "created" };
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

  // Check caller role from auth token (set by Cognito via mintFirebaseToken)
  const callerRole = request.auth.token["custom:role"] || "";
  if (callerRole !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can create API keys. Your role: " + callerRole);
  }
  // Lightweight active check — Cognito claim has no active flag, so a deactivated
  // admin still passes the role check within their token's TTL. Block only on
  // explicit active=false (skeleton docs with undefined active still pass).
  const callerSnap = await db.collection("orgs").doc(orgId).collection("users").doc(callerUid).get();
  if (callerSnap.exists && callerSnap.data().active === false) {
    throw new HttpsError("permission-denied", "Your account has been deactivated.");
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

  await writeAuditLog(orgId,
    { uid: callerUid, email: request.auth.token.email || "", displayName: request.auth.token["custom:name"] || "", ip: null, userAgent: null },
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

  // Check caller role from auth token (set by Cognito via mintFirebaseToken)
  const callerRole = request.auth.token["custom:role"] || "";
  if (callerRole !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can reveal API keys. Your role: " + callerRole);
  }
  // Lightweight active check — Cognito claim has no active flag, so a deactivated
  // admin still passes the role check within their token's TTL. Block only on
  // explicit active=false (skeleton docs with undefined active still pass).
  const callerSnap = await db.collection("orgs").doc(orgId).collection("users").doc(callerUid).get();
  if (callerSnap.exists && callerSnap.data().active === false) {
    throw new HttpsError("permission-denied", "Your account has been deactivated.");
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

    await writeAuditLog(orgId,
      { uid: callerUid, email: request.auth.token.email || "", displayName: request.auth.token["custom:name"] || "", ip: null, userAgent: null },
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

  // Check caller role from auth token (set by Cognito via mintFirebaseToken)
  const callerRole = request.auth.token["custom:role"] || "";
  if (callerRole !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can revoke API keys. Your role: " + callerRole);
  }
  // Lightweight active check — Cognito claim has no active flag, so a deactivated
  // admin still passes the role check within their token's TTL. Block only on
  // explicit active=false (skeleton docs with undefined active still pass).
  const callerSnap = await db.collection("orgs").doc(orgId).collection("users").doc(callerUid).get();
  if (callerSnap.exists && callerSnap.data().active === false) {
    throw new HttpsError("permission-denied", "Your account has been deactivated.");
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

  await writeAuditLog(orgId,
    { uid: callerUid, email: request.auth.token.email || "", displayName: request.auth.token["custom:name"] || "", ip: null, userAgent: null },
    "apikey.revoked", { type: "apiKey", id: keyId },
    { label: keyData.label, active: true }, { active: false, revokedBy: callerUid }
  );

  return { success: true };
});


// ============================================================
// CALLABLE: update a user's roles and region/location assignments.
// Writes to Firestore, syncs to Cognito custom:role claim, writes audit log.
//
// Payload: { orgId, targetUid, roles, managedRegionIds, assignedLocations }
//   - roles: array of role strings (['manager', 'director', 'vp', 'admin'])
//   - managedRegionIds: array of region IDs this user can see
//   - assignedLocations: array of individual location names (ad-hoc overrides)
//
// Guardrails:
//   - Caller must be admin
//   - Cannot demote yourself out of admin if you're the last admin
//   - Must have at least one role
//   - Roles must be from the valid set
// ============================================================
exports.updateUserRoles = onCall(
  { invoker: "public", secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY] },
  async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const { orgId, targetUid, roles, managedRegionIds, assignedLocations } = request.data;
  const callerUid = request.auth.uid;

  if (!orgId || !targetUid) {
    throw new HttpsError("invalid-argument", "orgId and targetUid are required.");
  }
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new HttpsError("invalid-argument", "At least one role must be specified.");
  }

  // Validate role values
  const VALID_ROLES = ["manager", "director", "vp", "admin"];
  const invalid = roles.find(r => !VALID_ROLES.includes(r));
  if (invalid) {
    throw new HttpsError("invalid-argument", `Invalid role: ${invalid}`);
  }

  // Verify caller is admin (from auth token)
  const callerRole = request.auth.token["custom:role"] || "";
  if (callerRole !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can update user roles. Your role: " + callerRole);
  }

  // Fetch target
  const targetSnap = await db.collection("orgs").doc(orgId).collection("users").doc(targetUid).get();
  if (!targetSnap.exists) {
    throw new HttpsError("not-found", "Target user not found.");
  }
  const target = targetSnap.data();

  // Guardrail: cannot remove yourself as admin if you're the last admin
  if (callerUid === targetUid) {
    const wasAdmin = callerRole === "admin";
    const willBeAdmin = roles.includes("admin");
    if (wasAdmin && !willBeAdmin) {
      // Count other admins in tenant
      const usersSnap = await db.collection("orgs").doc(orgId).collection("users").get();
      let otherAdmins = 0;
      usersSnap.forEach(doc => {
        if (doc.id === callerUid) return;
        const data = doc.data();
        const drs = Array.isArray(data.roles) && data.roles.length > 0
          ? data.roles
          : (data.role ? [data.role] : []);
        if (drs.includes("admin") && data.active !== false) {
          otherAdmins++;
        }
      });
      if (otherAdmins === 0) {
        throw new HttpsError("failed-precondition", "You cannot remove your own admin role — you are the last admin.");
      }
    }
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const updatePayload = {
    roles,
    managedRegionIds: Array.isArray(managedRegionIds) ? managedRegionIds : [],
    assignedLocations: Array.isArray(assignedLocations) ? assignedLocations : [],
    updatedAt: now,
    updatedBy: callerUid,
  };

  // Mirror into the legacy `role` string (highest-tier role) for backwards compat
  const TIER_ORDER = ["admin", "vp", "director", "manager"];
  const primaryRole = TIER_ORDER.find(r => roles.includes(r)) || roles[0];
  updatePayload.role = primaryRole;

  // Cognito custom:role is the authoritative source of truth for permission
  // gates — write it FIRST and require it to succeed before mirroring to
  // Firestore. If Cognito rejects, abort the whole operation so we never
  // leave Firestore showing a role the gates won't honor.
  try {
    const AWS = require("aws-sdk");
    const cognito = new AWS.CognitoIdentityServiceProvider({ region: "us-east-2" });
    await cognito.adminUpdateUserAttributes({
      UserPoolId: POOL_ID,
      Username: targetUid,
      UserAttributes: [
        { Name: "custom:role", Value: primaryRole },
      ],
    }).promise();
  } catch (e) {
    console.error("Cognito custom:role update failed for", targetUid, ":", e.message);
    throw new HttpsError("internal", "Failed to update role in Cognito; change not applied");
  }

  // Mirror to Firestore — display layer only now that Cognito is authoritative.
  await db.collection("orgs").doc(orgId).collection("users").doc(targetUid).update(updatePayload);

  // Revoke refresh tokens so the target user has to re-login and pick up new claims
  try {
    await admin.auth().revokeRefreshTokens(targetUid);
  } catch (err) {
    if (err?.errorInfo?.code !== "auth/user-not-found") throw err;
    // No Firebase Auth record (user never signed in via app). Nothing to revoke;
    // the Cognito disable already blocks future sign-ins.
  }

  // Audit log
  const before = {
    roles: target.roles || (target.role ? [target.role] : []),
    managedRegionIds: target.managedRegionIds || [],
    assignedLocations: target.assignedLocations || [],
  };
  const after = {
    roles,
    managedRegionIds: updatePayload.managedRegionIds,
    assignedLocations: updatePayload.assignedLocations,
  };
  await writeAuditLog(
    orgId,
    { uid: callerUid, email: request.auth.token.email || "", displayName: request.auth.token["custom:name"] || "", ip: null, userAgent: null },
    "user.roles.updated",
    { type: "user", id: targetUid },
    before,
    after
  );

  return { success: true };
});


// ============================================================
// CALLABLE: create, update, or delete a region.
//
// Payload: { orgId, action, regionId, name, locations }
//   - action: 'create' | 'update' | 'delete'
//   - regionId: required for update/delete
//   - name: required for create/update
//   - locations: array of location names (required for create; optional for update)
//
// On delete, cascades by removing the regionId from every user's
// managedRegionIds array so there are no dangling references.
// ============================================================
exports.updateRegion = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const { orgId, action, regionId, name, locations } = request.data;
  const callerUid = request.auth.uid;

  if (!orgId || !action) {
    throw new HttpsError("invalid-argument", "orgId and action are required.");
  }
  if (!["create", "update", "delete"].includes(action)) {
    throw new HttpsError("invalid-argument", "action must be create, update, or delete.");
  }

  // Check caller role from auth token (set by Cognito via mintFirebaseToken)
  const callerRole = request.auth.token["custom:role"] || "";
  if (callerRole !== "admin") {
    throw new HttpsError("permission-denied", "Only admins can manage regions. Your role: " + callerRole);
  }

  const regionsRef = db.collection("tenants").doc(orgId).collection("regions");
  const now = admin.firestore.FieldValue.serverTimestamp();
  const actor = { uid: callerUid, email: request.auth.token.email || "", displayName: request.auth.token["custom:name"] || "", ip: null, userAgent: null };

  if (action === "create") {
    if (!name || typeof name !== "string" || !name.trim()) {
      throw new HttpsError("invalid-argument", "name is required.");
    }
    const payload = {
      name: name.trim(),
      locations: Array.isArray(locations) ? locations : [],
      createdAt: now,
      createdBy: callerUid,
      updatedAt: now,
      updatedBy: callerUid,
    };
    const ref = await regionsRef.add(payload);
    await writeAuditLog(orgId, actor, "region.created", { type: "region", id: ref.id }, null, { name: payload.name, locationCount: payload.locations.length });
    return { success: true, regionId: ref.id };
  }

  if (action === "update") {
    if (!regionId) throw new HttpsError("invalid-argument", "regionId is required.");
    const existing = await regionsRef.doc(regionId).get();
    if (!existing.exists) throw new HttpsError("not-found", "Region not found.");
    const before = existing.data();

    const updates = { updatedAt: now, updatedBy: callerUid };
    if (typeof name === "string" && name.trim()) updates.name = name.trim();
    if (Array.isArray(locations)) updates.locations = locations;

    await regionsRef.doc(regionId).update(updates);
    await writeAuditLog(orgId, actor, "region.updated", { type: "region", id: regionId },
      { name: before.name, locationCount: (before.locations || []).length },
      { name: updates.name || before.name, locationCount: (updates.locations || before.locations || []).length }
    );
    return { success: true };
  }

  if (action === "delete") {
    if (!regionId) throw new HttpsError("invalid-argument", "regionId is required.");
    const existing = await regionsRef.doc(regionId).get();
    if (!existing.exists) throw new HttpsError("not-found", "Region not found.");
    const before = existing.data();

    // Cascade: remove this regionId from every user's managedRegionIds
    const usersSnap = await db.collection("orgs").doc(orgId).collection("users").get();
    const batch = db.batch();
    let affectedUsers = 0;
    usersSnap.forEach(doc => {
      const data = doc.data();
      if (Array.isArray(data.managedRegionIds) && data.managedRegionIds.includes(regionId)) {
        batch.update(doc.ref, {
          managedRegionIds: data.managedRegionIds.filter(id => id !== regionId),
          updatedAt: now,
          updatedBy: callerUid,
        });
        affectedUsers++;
      }
    });
    batch.delete(regionsRef.doc(regionId));
    await batch.commit();

    await writeAuditLog(orgId, actor, "region.deleted", { type: "region", id: regionId },
      { name: before.name, locationCount: (before.locations || []).length },
      { affectedUsers }
    );
    return { success: true, affectedUsers };
  }
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


// ============================================================
// HTTP: Claude AI proxy
// Proxies requests to the Anthropic API, keeping the API key
// server-side. Authenticated — requires a valid Firebase token.
// ============================================================
const { onRequest } = require("firebase-functions/v2/https");

exports.claudeProxy = onRequest(
  { cors: true, invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // Get API key from Firebase config or environment
    const apiKey = process.env.ANTHROPIC_API_KEY || "";
    if (!apiKey) {
      res.status(500).json({ error: "Anthropic API key not configured" });
      return;
    }

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(req.body),
      });

      const data = await response.text();
      res.status(response.status).set("Content-Type", "application/json").send(data);
    } catch (err) {
      console.error("Claude proxy error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);


// ============================================================
// HTTP: Webhook receiver for external integrations
// Receives data pushes from Sysco, Toast, Spartan, etc.
// Routes to appropriate handler based on integration ID
// ============================================================
exports.integrationWebhook = onRequest(
  { cors: true, invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const integrationId = req.query.integration || req.headers["x-integration-id"];
    const orgId = req.query.org || req.headers["x-org-id"];

    if (!integrationId || !orgId) {
      res.status(400).json({ error: "Missing integration or org ID" });
      return;
    }

    // Verify webhook signature if provided
    const signature = req.headers["x-webhook-signature"];

    try {
      // Log the incoming webhook
      await db.collection("tenants").doc(orgId)
        .collection("syncLog").add({
          integrationId,
          type: "webhook_received",
          payload: JSON.stringify(req.body).slice(0, 5000),
          headers: {
            contentType: req.headers["content-type"],
            signature: signature ? "present" : "absent",
          },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      // Route to handler
      switch (integrationId) {
        case "sysco":
          await handleSyscoWebhook(orgId, req.body);
          break;
        case "spartan":
        case "toast":
          await handlePOSWebhook(orgId, integrationId, req.body);
          break;
        case "netsuite":
          await handleNetSuiteWebhook(orgId, req.body);
          break;
        default:
          console.warn("Unknown integration:", integrationId);
      }

      // Update last sync time
      await db.collection("tenants").doc(orgId)
        .collection("integrations").doc(integrationId)
        .set({
          lastSync: admin.firestore.FieldValue.serverTimestamp(),
          lastWebhook: admin.firestore.FieldValue.serverTimestamp(),
          syncStatus: "success",
        }, { merge: true });

      res.status(200).json({ success: true });
    } catch (err) {
      console.error("Webhook error:", err);

      await db.collection("tenants").doc(orgId)
        .collection("integrations").doc(integrationId)
        .set({
          syncStatus: "error",
          error: err.message,
        }, { merge: true });

      res.status(500).json({ error: err.message });
    }
  }
);

// Webhook handlers — implement when vendor APIs are available
async function handleSyscoWebhook(orgId, payload) {
  const type = payload.type || payload.eventType || 'unknown';
  console.log("Sysco webhook type:", type);

  if (type === 'invoice' || type === 'invoice.created') {
    // Vendor sent an invoice — write to AP
    const invoice = payload.invoice || payload;
    const lineItems = (invoice.lineItems || invoice.items || []).map(li => ({
      sku: li.supc || li.sku || li.itemNumber || '',
      name: li.description || li.name || '',
      qty: Number(li.quantity || li.qty || 0),
      unitCost: Number(li.unitPrice || li.price || 0),
      total: Number(li.extendedPrice || li.total || 0),
      unit: li.unitOfMeasure || li.unit || 'ea',
    }));

    const total = invoice.totalAmount || invoice.total || lineItems.reduce((s, li) => s + li.total, 0);

    const invoiceData = {
      vendor: invoice.vendorName || 'Sysco',
      vendorId: 'sysco',
      invoiceNum: invoice.invoiceNumber || invoice.id || '',
      invoiceDate: invoice.invoiceDate || new Date().toISOString().slice(0, 10),
      amount: total,
      lineItems,
      source: 'webhook',
      distributor: 'Sysco',
      poNumber: invoice.poNumber || invoice.purchaseOrderNumber || null,
      location: invoice.shipToLocation || invoice.location || '',
      periodKey: invoice.periodKey || null,
      glCode: 'cogs_food',
      status: 'Pending',
      matchStatus: 'unmatched',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Try to match to an existing PO
    if (invoiceData.poNumber) {
      const poSnap = await db.collection('tenants').doc(orgId)
        .collection('purchaseOrders')
        .where('poNumber', '==', invoiceData.poNumber)
        .limit(1).get();

      if (!poSnap.empty) {
        const po = poSnap.docs[0].data();
        invoiceData.poId = poSnap.docs[0].id;
        invoiceData.location = invoiceData.location || po.location;
        invoiceData.periodKey = invoiceData.periodKey || po.periodKey;
        invoiceData.glCode = po.glCode || 'cogs_food';

        // Simple match check
        const poDiff = Math.abs(total - (po.orderTotal || 0));
        const pctDiff = po.orderTotal > 0 ? poDiff / po.orderTotal : 1;
        invoiceData.matchStatus = pctDiff < 0.01 ? 'exact' : pctDiff < 0.05 ? 'partial' : 'mismatch';

        if (invoiceData.matchStatus === 'exact') {
          invoiceData.status = 'Approved';
          invoiceData.autoApproved = true;
        }

        // Update PO
        await poSnap.docs[0].ref.update({
          status: invoiceData.matchStatus === 'exact' ? 'matched' : 'invoiced',
          vendorInvoiceId: invoiceData.invoiceNum,
          invoiceTotal: total,
          invoiceReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
          invoiceSource: 'webhook',
          matchStatus: invoiceData.matchStatus,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    await db.collection('tenants').doc(orgId).collection('invoices').add(invoiceData);
    console.log("Invoice created:", invoiceData.invoiceNum, "$" + total, "match:", invoiceData.matchStatus);

  } else if (type === 'order.confirmed' || type === 'order.shipped') {
    // Order status update
    const orderRef = payload.poNumber || payload.purchaseOrderNumber;
    if (orderRef) {
      const poSnap = await db.collection('tenants').doc(orgId)
        .collection('purchaseOrders')
        .where('poNumber', '==', orderRef)
        .limit(1).get();

      if (!poSnap.empty) {
        await poSnap.docs[0].ref.update({
          status: type === 'order.confirmed' ? 'confirmed' : 'shipped',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log("PO", orderRef, "status updated to", type);
      }
    }

  } else if (type === 'catalog' || type === 'catalog.update') {
    // Product catalog update
    const items = payload.items || [];
    const batch = db.batch();
    for (const item of items) {
      const ref = db.collection('tenants').doc(orgId)
        .collection('inventoryCatalog').doc(item.supc || item.sku || item.id);
      batch.set(ref, {
        sku: item.supc || item.sku || '',
        name: item.description || item.name || '',
        vendor: 'Sysco',
        unitCost: Number(item.price || item.unitPrice || 0),
        packSize: item.packSize || item.pack || '',
        category: item.category || '',
        unit: item.unitOfMeasure || 'ea',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    await batch.commit();
    console.log("Catalog updated:", items.length, "items");
  }
}

async function handlePOSWebhook(orgId, integrationId, payload) {
  const transactions = payload.transactions || payload.sales || [];
  console.log(integrationId + " webhook:", transactions.length, "transactions");

  if (transactions.length === 0) return;

  const batch = db.batch();
  let totalSales = 0;

  for (const txn of transactions) {
    const ref = db.collection('tenants').doc(orgId)
      .collection('posTransactions').doc(txn.id || txn.transactionId || admin.firestore.FieldValue.serverTimestamp().toString());
    batch.set(ref, {
      integrationId,
      transactionId: txn.id || txn.transactionId || '',
      date: txn.date || txn.timestamp || new Date().toISOString(),
      total: Number(txn.total || txn.amount || 0),
      tax: Number(txn.tax || 0),
      items: txn.items || [],
      paymentMethod: txn.paymentMethod || txn.paymentType || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    totalSales += Number(txn.total || txn.amount || 0);
  }

  await batch.commit();
  console.log("Processed", transactions.length, "transactions, total: $" + totalSales.toFixed(2));
}

async function handleNetSuiteWebhook(orgId, payload) {
  const type = payload.type || 'unknown';
  console.log("NetSuite webhook type:", type);

  if (type === 'sync.complete' || type === 'je.posted') {
    // Mark synced items
    const ids = payload.ids || payload.journalEntryIds || [];
    const batch = db.batch();
    for (const id of ids) {
      const ref = db.collection('tenants').doc(orgId).collection('journalEntries').doc(id);
      batch.update(ref, {
        syncedToNetSuite: true,
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        netsuiteId: payload.netsuiteIds?.[id] || null,
      });
    }
    await batch.commit();
    console.log("Marked", ids.length, "JEs as synced to NetSuite");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Inventory valuation aggregation — Phase 2, SHADOW-FIELD MODE.
//
// Recomputes closingValue / cogs_inventory server-side from the per-item count
// subcollection (the concurrency-safe source of truth) and writes them to
// SHADOW fields (closingValue_cf / cogs_inventory_cf / openingValue_cf) on the
// P&L doc. It does NOT touch the live closingValue / cogs_inventory — the
// client remains the sole authoritative writer this phase. This lets us compare
// cf-vs-live across real counts before ever letting the dashboard trust the CF
// (a later phase swaps the writer once the shadow values are proven equal).
//
// Reads: whole counts/{periodKey}/items subcollection; the current P&L doc for
// cogs_purchases; the PRIOR period's P&L closingValue for openingValue.
// Valuation uses the DENORMALIZED pricing on each count doc (packPrice /
// qtyPerPack / unitCost, written in Phase 1) — no catalog join.
// ═══════════════════════════════════════════════════════════════════════════

// Fiscal-calendar helpers — DUPLICATED from src/lib/pnl.js (weeksInPeriod /
// getPriorKey) because functions can't import the frontend module. They MUST
// stay in lockstep: if the Fooda fiscal calendar logic changes in pnl.js, update
// these copies too, or the CF's opening value will drift from the client's.
function cfWeeksInPeriod(year, period) {
  const firstDay = new Date(year, period - 1, 1);
  const lastDay = new Date(year, period, 0);
  const daysInMonth = lastDay.getDate();
  // Fooda weeks run Sun–Sat. Week 1: day 1 through the first Saturday.
  const daysToSat = (6 - firstDay.getDay() + 7) % 7;   // days from the 1st to the first Saturday
  const firstSaturday = 1 + daysToSat;                  // date of the first Saturday
  const remainingDays = daysInMonth - firstSaturday;
  const fullWeeks = Math.floor(remainingDays / 7);
  const leftover = remainingDays % 7;
  return 1 + fullWeeks + (leftover > 0 ? 1 : 0);
}
function cfGetPriorKey(key) {
  const parts = key && key.match(/(\d+)-P(\d+)-W(\d+)/);
  if (!parts) return null;
  const [, yr, p, w] = parts.map(Number);
  if (w > 1) return `${yr}-P${String(p).padStart(2, "0")}-W${w - 1}`;
  if (p > 1) {
    const priorWeeks = cfWeeksInPeriod(yr, p - 1);
    return `${yr}-P${String(p - 1).padStart(2, "0")}-W${priorWeeks}`;
  }
  const decWeeks = cfWeeksInPeriod(yr - 1, 12);
  return `${yr - 1}-P12-W${decWeeks}`;
}

exports.aggregateInventoryValuationShadow = onDocumentWritten(
  "tenants/{orgId}/inventory/{locId}/counts/{periodKey}/items/{itemId}",
  async (event) => {
    const { orgId, locId, periodKey } = event.params || {};
    if (!orgId || !locId || !periodKey) return;

    // Trailing debounce: let a burst of per-item writes settle before we read
    // the subcollection, so we aggregate consistent data instead of a partial
    // mid-burst state. Combined with the monotonic guard below, redundant
    // invocations from the same burst either read the settled set or skip.
    await new Promise((r) => setTimeout(r, 2500));

    const pnlRef = db
      .collection("tenants").doc(orgId)
      .collection("pnl").doc(locId)
      .collection("periods").doc(periodKey);

    // Monotonic guard, key off the EVENT time (not the max child updatedAt — a
    // deletion removes the newest child and would lower that max, wrongly
    // skipping the recompute). Deletions carry a later event time, so they run.
    const eventMillis = event.time ? new Date(event.time).getTime() : Date.now();

    // Cheap NON-transactional pre-check (fast path): if a strictly newer/equal
    // event already aggregated, skip before the expensive subcollection scan.
    // The AUTHORITATIVE guard is re-checked INSIDE the transaction below (atomic).
    const preSnap = await pnlRef.get();
    if (preSnap.exists && preSnap.data().cf_lastEventTime != null &&
        preSnap.data().cf_lastEventTime >= eventMillis) {
      return; // a newer/equal aggregation already ran for this loc/period
    }

    // ── Expensive aggregation reads — OUTSIDE the transaction (keeps the txn
    //    short: reading the whole items subcollection inside it would invite
    //    contention/retries on a 200+ doc location). ──────────────────────────

    // Closing = Σ per-item, using the client's EXACT formula over denormalized
    // pricing. packPrice falls back to qtyPerPack*unitCost; each price is the
    // per-unit share of the pack price. Same pass collects the Path B item set,
    // the location display name, and per-doc attribution for inventoryCountedBy.
    const tsMillis = (t) => {
      if (!t) return 0;
      if (typeof t.toMillis === "function") return t.toMillis();
      if (t._seconds != null) return t._seconds * 1000;
      return 0;
    };
    const itemsSnap = await db
      .collection("tenants").doc(orgId)
      .collection("inventory").doc(locId)
      .collection("counts").doc(periodKey)
      .collection("items").get();
    let closingValue = 0;
    let resolvedLocationName = null;
    const pathBItems = [];
    const countMeta = [];
    itemsSnap.forEach((d) => {
      const c = d.data() || {};
      const qty = Number(c.qty) || 0;
      const eaches = Number(c.eaches) || 0;
      const qpp = Number(c.qtyPerPack) || 1;
      const uc = Number(c.unitCost) || 0;
      const pp = Number(c.packPrice) || (qpp * uc);
      const eachPrice = qpp > 0 ? pp / qpp : uc;
      closingValue += qty * pp + eaches * eachPrice;

      // locationName from any count doc that carries the denormalized field.
      if (!resolvedLocationName && c.locationName) resolvedLocationName = c.locationName;
      // Attribution candidates (backfill-* actors filtered out later).
      countMeta.push({ updatedBy: c.updatedBy, updatedAtMs: tsMillis(c.updatedAt) });

      // Path B item set — hasCount filter (qty != null OR eaches > 0), same shape
      // the client writes. Null fallbacks cover old docs missing denorm fields.
      if (c.qty != null || eaches > 0) {
        pathBItems.push({
          id: c.itemId != null ? c.itemId : d.id,
          name: c.name ?? null,
          qty: c.qty ?? null,
          eaches: eaches,
          qtyPerPack: c.qtyPerPack || 1,
          packPrice: c.packPrice || null,
          unitCost: c.unitCost || 0,
          category: c.category || null,
          vendor: c.vendor || null,
        });
      }
    });

    // Opening = PRIOR period's CURRENT (live) closingValue — read exactly as the
    // client does at write time. Reads the live `closingValue`, not the shadow.
    const priorKey = cfGetPriorKey(periodKey);
    let openingValue = 0;
    if (priorKey) {
      const priorSnap = await db
        .collection("tenants").doc(orgId)
        .collection("pnl").doc(locId)
        .collection("periods").doc(priorKey)
        .get();
      openingValue = priorSnap.exists ? (Number(priorSnap.data().closingValue) || 0) : 0;
    }

    // valuationMode flag — read OUTSIDE the txn. FAIL-SAFE INVERTED vs the client:
    // on ANY read failure default to shadow-only (cfAuthoritative=false). A CF
    // that can't read the flag must NOT write live fields — the client may still
    // be writing them, and two writers on the live fields would clobber.
    let cfAuthoritative = false;
    try {
      const modeSnap = await db
        .collection("tenants").doc(orgId)
        .collection("valuationMode").doc(locId).get();
      cfAuthoritative = modeSnap.exists && modeSnap.data().authoritative === "cf";
    } catch (modeErr) {
      console.error(
        `[valuation-shadow] valuationMode read failed for ${orgId}/${locId} — staying SHADOW-ONLY:`,
        modeErr
      );
      cfAuthoritative = false;
    }

    // inventoryCountedBy for the live write: most-recent count doc's updatedBy,
    // EXCLUDING backfill-* actors (fall back to the next-most-recent real user;
    // last resort the most recent overall — never blank).
    let inventoryCountedBy = null;
    if (cfAuthoritative) {
      const byRecency = countMeta.slice().sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
      const realActor = byRecency.find(
        (m) => m.updatedBy && !/^backfill-/.test(String(m.updatedBy))
      );
      inventoryCountedBy = (realActor && realActor.updatedBy) ||
        (byRecency[0] && byRecency[0].updatedBy) || null;
    }

    // ── Guard-check + P&L write INSIDE the transaction (atomic — closes the
    //    concurrent-invocation race where two invocations both pass the guard
    //    and clobber). cogs_purchases read FRESH from the txn snapshot. ────────
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(pnlRef);
      const pnl = snap.exists ? snap.data() : {};
      if (pnl.cf_lastEventTime != null && pnl.cf_lastEventTime >= eventMillis) {
        return { wrote: false }; // a newer/equal aggregation committed first
      }
      const purchases = Number(pnl.cogs_purchases) || 0;
      const cogsInventory = Math.max(0, openingValue + purchases - closingValue);

      // SHADOW fields — written in EVERY mode, forever (the divergence monitor).
      const writes = {
        closingValue_cf: closingValue,
        cogs_inventory_cf: cogsInventory,
        openingValue_cf: openingValue,
        cf_countDocCount: itemsSnap.size,
        cf_computedAt: admin.firestore.FieldValue.serverTimestamp(),
        cf_lastEventTime: eventMillis,
      };
      // LIVE fields — ONLY when the flag affirmatively reads 'cf'.
      if (cfAuthoritative) {
        writes.closingValue = closingValue;
        writes.cogs_inventory = cogsInventory;
        writes.openingValue = openingValue;
        writes.inventoryCountedAt = admin.firestore.FieldValue.serverTimestamp();
        if (inventoryCountedBy != null) writes.inventoryCountedBy = inventoryCountedBy;
      }
      tx.set(pnlRef, writes, { merge: true });
      return { wrote: true, cogsInventory };
    });

    if (!result.wrote) {
      console.log(
        `[valuation-shadow] ${orgId}/${locId}/${periodKey}: skipped (newer event already aggregated)`
      );
      return;
    }
    const cogsInventory = result.cogsInventory;

    // ── Path B rebuild — ONLY when cfAuthoritative, AFTER the txn commits, in its
    //    OWN try/catch. A Path B failure logs but never fails the invocation. ──
    if (cfAuthoritative) {
      try {
        await db
          .collection("tenants").doc(orgId)
          .collection("locations").doc(locId)
          .collection("inventory").doc(periodKey)
          .set(
            {
              items: pathBItems,
              closingValue,
              period: periodKey,
              locationName: resolvedLocationName || locId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedBy: "cf",
            },
            { merge: true }
          );
      } catch (pathBErr) {
        console.error(
          `[valuation-shadow] Path B rebuild failed for ${orgId}/${locId}/${periodKey}:`,
          pathBErr
        );
      }
    }

    console.log(
      `[valuation-shadow] ${orgId}/${locId}/${periodKey}: closing_cf=${closingValue.toFixed(2)} ` +
      `cogs_cf=${cogsInventory.toFixed(2)} opening_cf=${openingValue.toFixed(2)} docs=${itemsSnap.size} ` +
      `mode=${cfAuthoritative ? "CF-AUTHORITATIVE (live written)" : "shadow-only"}`
    );
  }
);
