// src/pages/Settings/index.jsx
// Entry point — tab shell + lazy-loaded panels

import { useState } from "react";
import UsersTab     from "./tabs/UsersTab";
import LocationsTab from "./tabs/LocationsTab";
import APIKeysTab   from "./tabs/APIKeysTab";
import AuditLogTab  from "./tabs/AuditLogTab";
import SSOTab       from "./tabs/SSOTab";
import { useAuth }  from "../../hooks/useAuth";

const TABS = [
  { id: "users",     label: "Users & roles",  adminOnly: false },
  { id: "locations", label: "Locations",       adminOnly: true  },
  { id: "apikeys",   label: "API keys",        adminOnly: true  },
  { id: "audit",     label: "Audit log",       adminOnly: true  },
  { id: "sso",       label: "Single sign-on",  adminOnly: true  },
];

export default function Settings() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState("users");
  const isAdmin = user?.role === "admin";

  const visibleTabs = TABS.filter(t => !t.adminOnly || isAdmin);

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1>Settings</h1>
        <p className="settings-subtitle">Manage your organization, users, and integrations</p>
      </div>

      <nav className="settings-tabs">
        {visibleTabs.map(t => (
          <button
            key={t.id}
            className={`settings-tab ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="settings-panel">
        {activeTab === "users"     && <UsersTab />}
        {activeTab === "locations" && <LocationsTab />}
        {activeTab === "apikeys"   && <APIKeysTab />}
        {activeTab === "audit"     && <AuditLogTab />}
        {activeTab === "sso"       && <SSOTab />}
      </div>
    </div>
  );
}


// ============================================================
// src/pages/Settings/tabs/UsersTab.jsx
// User list with pagination, invite modal, role management
// ============================================================
import { useState, useEffect, useCallback } from "react";
import { db, functions }   from "../../../firebase";
import { httpsCallable }   from "firebase/functions";
import {
  collection, query, orderBy,
  limit, startAfter, getDocs, where
} from "firebase/firestore";
import { useAuth }         from "../../../hooks/useAuth";
import InviteModal         from "../components/InviteModal";
import UserRow             from "../components/UserRow";
import EmptyState          from "../../../components/EmptyState";
import Spinner             from "../../../components/Spinner";

const PAGE_SIZE = 20;

export default function UsersTab() {
  const { user, orgId }  = useAuth();
  const isAdmin          = user?.role === "admin";

  const [users,       setUsers]       = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastDoc,     setLastDoc]     = useState(null);
  const [hasMore,     setHasMore]     = useState(true);
  const [showInvite,  setShowInvite]  = useState(false);
  const [filter,      setFilter]      = useState("all"); // "all" | "active" | "pending"
  const [error,       setError]       = useState(null);

  const fetchUsers = useCallback(async (cursor = null) => {
    cursor ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      let q = query(
        collection(db, "orgs", orgId, "users"),
        orderBy("createdAt", "desc"),
        limit(PAGE_SIZE)
      );
      if (filter !== "all") q = query(q, where("inviteStatus", "==", filter));
      if (cursor) q = query(q, startAfter(cursor));

      const snap = await getDocs(q);
      const docs = snap.docs.map(d => d.data());

      setUsers(prev => cursor ? [...prev, ...docs] : docs);
      setLastDoc(snap.docs[snap.docs.length - 1] ?? null);
      setHasMore(snap.docs.length === PAGE_SIZE);
    } catch (e) {
      setError("Failed to load users. Please try again.");
      console.error(e);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [orgId, filter]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const handleInviteSent = () => {
    setShowInvite(false);
    fetchUsers(); // refresh list
  };

  const handleDeactivate = async (targetUid) => {
    if (!window.confirm("Deactivate this user? They will lose access immediately.")) return;
    try {
      const deactivate = httpsCallable(functions, "deactivateUser");
      await deactivate({ orgId, targetUid });
      fetchUsers();
    } catch (e) {
      alert("Failed to deactivate user: " + e.message);
    }
  };

  return (
    <div className="tab-content">
      <div className="tab-toolbar">
        <div className="filter-group">
          {["all", "active", "pending"].map(f => (
            <button
              key={f}
              className={`filter-btn ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        {isAdmin && (
          <button className="btn-primary" onClick={() => setShowInvite(true)}>
            + Invite user
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <Spinner />
      ) : users.length === 0 ? (
        <EmptyState
          title="No users yet"
          description="Invite your first team member to get started."
          action={isAdmin ? { label: "Invite user", onClick: () => setShowInvite(true) } : null}
        />
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Locations</th>
                <th>Status</th>
                <th>Last login</th>
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <UserRow
                  key={u.uid}
                  user={u}
                  orgId={orgId}
                  isAdmin={isAdmin}
                  currentUid={user.uid}
                  onDeactivate={handleDeactivate}
                  onUpdated={fetchUsers}
                />
              ))}
            </tbody>
          </table>

          {hasMore && (
            <button
              className="load-more-btn"
              onClick={() => fetchUsers(lastDoc)}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          )}
        </>
      )}

      {showInvite && (
        <InviteModal
          orgId={orgId}
          onClose={() => setShowInvite(false)}
          onSuccess={handleInviteSent}
        />
      )}
    </div>
  );
}


// ============================================================
// src/pages/Settings/components/InviteModal.jsx
// ============================================================
import { useState } from "react";
import { db, functions } from "../../../firebase";
import { httpsCallable } from "firebase/functions";
import { collection, getDocs } from "firebase/firestore";

export default function InviteModal({ orgId, onClose, onSuccess }) {
  const [form, setForm] = useState({
    email: "", displayName: "", role: "manager", locationIds: []
  });
  const [locations, setLocations] = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);

  // Load locations for assignment
  useState(() => {
    getDocs(collection(db, "orgs", orgId, "locations"))
      .then(snap => setLocations(snap.docs.map(d => d.data())));
  }, [orgId]);

  const toggleLocation = (id) => {
    setForm(f => ({
      ...f,
      locationIds: f.locationIds.includes(id)
        ? f.locationIds.filter(l => l !== id)
        : [...f.locationIds, id]
    }));
  };

  const handleSubmit = async () => {
    if (!form.email || !form.displayName) {
      setError("Name and email are required.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const invite = httpsCallable(functions, "inviteUser");
      await invite({ orgId, ...form });
      onSuccess();
    } catch (e) {
      setError(e.message ?? "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Invite team member</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <label>Full name</label>
          <input
            type="text"
            placeholder="Jane Smith"
            value={form.displayName}
            onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))}
          />

          <label>Email address</label>
          <input
            type="email"
            placeholder="jane@company.com"
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
          />

          <label>Role</label>
          <select
            value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
          >
            <option value="admin">Admin — full access</option>
            <option value="director">Director — assigned locations, no user management</option>
            <option value="manager">Manager — data entry for assigned location</option>
          </select>

          {form.role !== "admin" && locations.length > 0 && (
            <>
              <label>Assign locations</label>
              <div className="location-picker">
                {locations.filter(l => l.active).map(l => (
                  <label key={l.locationId} className="location-option">
                    <input
                      type="checkbox"
                      checked={form.locationIds.includes(l.locationId)}
                      onChange={() => toggleLocation(l.locationId)}
                    />
                    {l.name}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Sending..." : "Send invite"}
          </button>
        </div>
      </div>
    </div>
  );
}


// ============================================================
// src/pages/Settings/components/UserRow.jsx
// ============================================================
import { useState } from "react";
import { db }       from "../../../firebase";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { formatDistanceToNow } from "date-fns";

const ROLE_LABELS = { admin: "Admin", director: "Director", manager: "Manager" };
const STATUS_MAP  = {
  active:  { label: "Active",  cls: "badge-green"  },
  pending: { label: "Pending", cls: "badge-amber"  },
  expired: { label: "Expired", cls: "badge-red"    },
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