// functions/index.js
"use strict";

const { onCall, HttpsError }    = require("firebase-functions/v2/https");
const { onDocumentWritten }     = require("firebase-functions/v2/firestore");
const { onSchedule }            = require("firebase-functions/v2/scheduler");
const admin                     = require("firebase-admin");
const { v4: uuid }              = require("uuid");

admin.initializeApp();
const db = admin.firestore();

const POOL_ID     = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID   = process.env.COGNITO_CLIENT_ID;


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
function generateTempPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}