// src/pages/Settings/components/UserRow.jsx
import { useState } from "react";
import { db }       from "../../../firebase";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { formatDistanceToNow } from "date-fns";

const ROLE_LABELS = { admin: "Admin", director: "Director", manager: "Manager" };
const STATUS_MAP  = {
  active:  { label: "Active",  cls: "badge-green" },
  pending: { label: "Pending", cls: "badge-amber" },
  expired: { label: "Expired", cls: "badge-red"   },
};

export default function UserRow({ user, orgId, isAdmin, currentUid, onDeactivate, onUpdated }) {
  const [editingRole, setEditingRole] = useState(false);
  const [saving,      setSaving]      = useState(false);
  const isSelf    = user.uid === currentUid;
  const status    = user.active ? (user.inviteStatus ?? "active") : "inactive";
  const statusCfg = STATUS_MAP[status] ?? { label: status, cls: "badge-gray" };

  const handleRoleChange = async (newRole) => {
    setSaving(true);
    try {
      await updateDoc(doc(db, "orgs", orgId, "users", user.uid), {
        role: newRole, updatedAt: serverTimestamp()
      });
      onUpdated();
    } catch (e) {
      alert("Failed to update role: " + e.message);
    } finally {
      setSaving(false);
      setEditingRole(false);
    }
  };

  return (
    <tr className={!user.active ? "row-inactive" : ""}>
      <td>
        <div className="user-cell">
          <div className="avatar">{user.displayName?.[0]?.toUpperCase() ?? "?"}</div>
          <span>{user.displayName}{isSelf && <span className="you-badge">you</span>}</span>
        </div>
      </td>
      <td className="text-secondary">{user.email}</td>
      <td>
        {isAdmin && !isSelf && editingRole ? (
          <select
            defaultValue={user.role}
            disabled={saving}
            onChange={e => handleRoleChange(e.target.value)}
            onBlur={() => setEditingRole(false)}
            autoFocus
          >
            <option value="admin">Admin</option>
            <option value="director">Director</option>
            <option value="manager">Manager</option>
          </select>
        ) : (
          <span
            className={`role-badge role-${user.role}`}
            onClick={() => isAdmin && !isSelf && setEditingRole(true)}
            title={isAdmin && !isSelf ? "Click to change role" : ""}
          >
            {ROLE_LABELS[user.role] ?? user.role}
          </span>
        )}
      </td>
      <td className="text-secondary">
        {user.role === "admin" ? "All locations" : "—"}
      </td>
      <td><span className={`badge ${statusCfg.cls}`}>{statusCfg.label}</span></td>
      <td className="text-secondary">
        {user.lastLoginAt
          ? formatDistanceToNow(user.lastLoginAt.toDate(), { addSuffix: true })
          : "Never"}
      </td>
      {isAdmin && (
        <td>
          {user.active && !isSelf && (
            <button className="action-btn danger" onClick={() => onDeactivate(user.uid)}>
              Deactivate
            </button>
          )}
        </td>
      )}
    </tr>
  );
}