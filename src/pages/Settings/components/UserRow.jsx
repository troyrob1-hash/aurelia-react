// src/pages/Settings/components/UserRow.jsx
//
// Renders a single row in the Users table. Admins can click "Edit access"
// to open the full EditAccessModal (roles + regions + ad-hoc locations).
// The old inline-role-select has been removed in favor of the modal because
// the role model now has 4 tiers (manager, director, vp, admin), they can
// be additive (multi-role users), and directors need region assignments —
// none of which fits a simple dropdown.

import { formatDistanceToNow } from "date-fns";
import {
  getUserRoles,
  ROLE_LABELS,
  summarizeUserAccess,
} from "@/lib/permissions";

const STATUS_MAP = {
  active:  { label: "Active",  cls: "badge-green" },
  pending: { label: "Pending", cls: "badge-amber" },
  expired: { label: "Expired", cls: "badge-red"   },
};

const ROLE_COLORS = {
  admin:    { bg: "#fce7f3", text: "#9f1239", border: "#fbcfe8" },
  vp:       { bg: "#ede9fe", text: "#5b21b6", border: "#ddd6fe" },
  director: { bg: "#dbeafe", text: "#1e40af", border: "#bfdbfe" },
  manager:  { bg: "#f1f5f9", text: "#475569", border: "#e2e8f0" },
};

export default function UserRow({
  user,
  isAdmin,
  currentUid,
  onDeactivate,
  onEdit,
  regionsById = {},
  allLocations = [],
}) {
  const isSelf = user.uid === currentUid;
  const status = user.active ? (user.inviteStatus ?? "active") : "inactive";
  const statusCfg = STATUS_MAP[status] ?? { label: status, cls: "badge-gray" };

  const userRoles = getUserRoles(user);
  const accessSummary = summarizeUserAccess(user, allLocations, regionsById);

  return (
    <tr className={!user.active ? "row-inactive" : ""}>
      <td>
        <div className="user-cell">
          <div className="avatar">{user.displayName?.[0]?.toUpperCase() ?? "?"}</div>
          <span>{user.displayName}{isSelf && <span className="you-badge">you</span>}</span>
        </div>
      </td>

      <td className="text-secondary">{user.email}</td>

      {/* Roles — chip strip */}
      <td>
        {userRoles.length === 0 ? (
          <span style={{ fontSize: 11, color: "#94a3b8", fontStyle: "italic" }}>No role</span>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {userRoles.map(r => {
              const c = ROLE_COLORS[r] || ROLE_COLORS.manager;
              return (
                <span
                  key={r}
                  style={{
                    fontSize: 10, fontWeight: 600,
                    padding: "3px 8px",
                    background: c.bg, color: c.text,
                    border: `0.5px solid ${c.border}`,
                    borderRadius: 12,
                    textTransform: "uppercase",
                    letterSpacing: "0.03em",
                  }}
                >
                  {ROLE_LABELS[r] || r}
                </span>
              );
            })}
          </div>
        )}
      </td>

      {/* Access summary */}
      <td className="text-secondary" style={{ fontSize: 12 }}>
        {accessSummary}
      </td>

      <td><span className={`badge ${statusCfg.cls}`}>{statusCfg.label}</span></td>

      <td className="text-secondary">
        {user.lastLoginAt
          ? formatDistanceToNow(user.lastLoginAt.toDate(), { addSuffix: true })
          : "Never"}
      </td>

      {isAdmin && (
        <td>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="action-btn"
              onClick={onEdit}
              style={{
                padding: "5px 10px",
                background: "#f8fafc",
                color: "#475569",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 500,
              }}
            >
              Edit access
            </button>
            {user.active && !isSelf && (
              <button
                className="action-btn danger"
                onClick={() => onDeactivate(user.uid)}
                style={{
                  padding: "5px 10px",
                  background: "#fff",
                  color: "#dc2626",
                  border: "1px solid #fca5a5",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                Deactivate
              </button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}
