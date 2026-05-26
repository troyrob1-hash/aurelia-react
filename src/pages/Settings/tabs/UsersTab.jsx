// src/pages/Settings/tabs/UsersTab.jsx
import { useState, useEffect, useCallback, useMemo } from "react";
import { db, functions }   from "@/lib/firebase";
import { httpsCallable }   from "firebase/functions";
import {
  collection, query, orderBy,
  limit, startAfter, getDocs, doc, updateDoc, where
} from "firebase/firestore";
import { useAuth }         from "@/hooks/useAuth";
import InviteModal         from "../components/InviteModal";
import UserRow             from "../components/UserRow";
import EditAccessModal     from "../components/EditAccessModal";
import { canAdministerSystem } from "@/lib/permissions";
import { useLocations }    from "@/store/LocationContext";
import EmptyState          from "@/components/ui/EmptyState";
import Spinner             from "@/components/ui/Spinner";
import { useToast }        from "@/components/ui/Toast";

const PAGE_SIZE = 20;

export default function UsersTab() {
  const { user, orgId }  = useAuth();
  const { allLocations, regionsList, regionsById } = useLocations();
  const isAdmin          = canAdministerSystem(user);

  const [users,       setUsers]       = useState([]);
  const [accessReqs,  setAccessReqs]  = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastDoc,     setLastDoc]     = useState(null);
  const [hasMore,     setHasMore]     = useState(true);
  const [showInvite,  setShowInvite]  = useState(false);
  const [approveReq,  setApproveReq]  = useState(null);
  const [filter,      setFilter]      = useState("all");
  const [error,       setError]       = useState(null);
  const [search,      setSearch]      = useState("");
  const [sortCol,     setSortCol]     = useState("createdAt");
  const [sortDir,     setSortDir]     = useState("desc");
  const [editingUser, setEditingUser] = useState(null);
  const toast = useToast();

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

  // Fetch pending access requests
  const fetchAccessReqs = useCallback(async () => {
    try {
      const snap = await getDocs(
        collection(db, "tenants", orgId, "accessRequests")
      );
      setAccessReqs(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.status === "pending").sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
    } catch (e) { console.error("Failed to load access requests:", e); }
  }, [orgId]);

  useEffect(() => { fetchAccessReqs(); }, [fetchAccessReqs]);

  async function approveRequest(req) {
    setShowInvite(true);
    setApproveReq(req);
  }

  async function denyRequest(req) {
    if (!window.confirm('Deny access request from ' + req.name + '?')) return;
    try {
      await updateDoc(doc(db, "tenants", orgId, "accessRequests", req.id), { status: "denied" });
      setAccessReqs(prev => prev.filter(r => r.id !== req.id));
    } catch (e) { console.error(e); }
  }

  const handleInviteSent = async () => {
    // If approving an access request, mark it as approved
    if (approveReq) {
      try {
        await updateDoc(doc(db, "tenants", orgId, "accessRequests", approveReq.id), { status: "approved" });
        setAccessReqs(prev => prev.filter(r => r.id !== approveReq.id));
      } catch (e) { console.error(e); }
      setApproveReq(null);
    }
    setShowInvite(false);
    toast.success("Invitation sent successfully");
    fetchUsers();
  };

  const handleDeactivate = async (targetUid) => {
    if (!window.confirm("Deactivate this user? They will lose access immediately.")) return;
    try {
      const deactivate = httpsCallable(functions, "deactivateUser");
      await deactivate({ orgId, targetUid });
      toast.success("User deactivated");
      fetchUsers();
    } catch (e) {
      toast.error("Failed to deactivate user: " + e.message);
    }
  };

  const handleRoleUpdated = () => {
    toast.success("Role updated");
    fetchUsers();
  };

  const handleSort = (col) => {
    if (sortCol === col) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const sortIndicator = (col) => {
    if (sortCol !== col) return <span style={{ opacity: 0.25, marginLeft: 4 }}>↕</span>;
    return <span style={{ marginLeft: 4 }}>{sortDir === "asc" ? "↑" : "↓"}</span>;
  };

  const filteredAndSorted = useMemo(() => {
    let list = [...users];
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter(u =>
        (u.displayName || "").toLowerCase().includes(s) ||
        (u.email || "").toLowerCase().includes(s)
      );
    }
    list.sort((a, b) => {
      let aVal, bVal;
      switch (sortCol) {
        case "displayName": aVal = a.displayName || ""; bVal = b.displayName || ""; break;
        case "email":       aVal = a.email || "";       bVal = b.email || "";       break;
        case "role":        aVal = a.role || "";         bVal = b.role || "";         break;
        case "lastLoginAt":
          aVal = a.lastLoginAt?.toMillis?.() ?? 0;
          bVal = b.lastLoginAt?.toMillis?.() ?? 0;
          return sortDir === "asc" ? aVal - bVal : bVal - aVal;
        default:
          aVal = a.createdAt?.toMillis?.() ?? 0;
          bVal = b.createdAt?.toMillis?.() ?? 0;
          return sortDir === "asc" ? aVal - bVal : bVal - aVal;
      }
      const cmp = String(aVal).localeCompare(String(bVal));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [users, search, sortCol, sortDir]);

  const activeCount = users.filter(u => u.active).length;

  return (
    <div className="tab-content">
      <div className="tab-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
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
          <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
            {activeCount} active {activeCount === 1 ? "user" : "users"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ position: "relative" }}>
            <input
              type="text"
              placeholder="Search users..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                padding: "7px 12px 7px 32px", fontSize: 13, width: 200,
                border: "0.5px solid var(--color-border-secondary, #ccc)",
                borderRadius: 8, background: "var(--color-background-primary)",
                color: "var(--color-text-primary)", fontFamily: "inherit",
              }}
            />
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="2" strokeLinecap="round" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }}>
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
            </svg>
          </div>
          {isAdmin && (
            <button className="btn-primary" onClick={() => setShowInvite(true)}>
              + Invite user
            </button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* Pending access requests */}
      {accessReqs.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#F15D3B', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#F15D3B', display: 'inline-block' }} />
            {accessReqs.length} pending access {accessReqs.length === 1 ? 'request' : 'requests'}
          </div>
          {accessReqs.map(req => (
            <div key={req.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a',
              borderRadius: 10, marginBottom: 6,
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{req.name}</div>
                <div style={{ fontSize: 13, color: '#64748b' }}>{req.email}</div>
                {req.message && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2, fontStyle: 'italic' }}>"{req.message}"</div>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => approveRequest(req)}
                  style={{ padding: '6px 16px', fontSize: 13, fontWeight: 600, background: '#1D9E75', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                  Approve
                </button>
                <button onClick={() => denyRequest(req)}
                  style={{ padding: '6px 16px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer' }}>
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : users.length === 0 ? (
        <EmptyState
          icon="users"
          title="No users yet"
          description="Invite your first team member to get started."
          action={isAdmin ? { label: "Invite user", onClick: () => setShowInvite(true) } : null}
        />
      ) : filteredAndSorted.length === 0 ? (
        <EmptyState
          icon="users"
          title="No matching users"
          description={`No users match "${search}". Try a different search term.`}
        />
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 1100 }}>
            <thead>
              <tr>
                <th className="sortable-th" onClick={() => handleSort("displayName")}>Name{sortIndicator("displayName")}</th>
                <th className="sortable-th" onClick={() => handleSort("email")}>Email{sortIndicator("email")}</th>
                <th className="sortable-th" onClick={() => handleSort("role")}>Role{sortIndicator("role")}</th>
                <th>Locations</th>
                <th>Status</th>
                <th className="sortable-th" onClick={() => handleSort("lastLoginAt")}>Last login{sortIndicator("lastLoginAt")}</th>
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {filteredAndSorted.map(u => (
                <UserRow
                  key={u.uid}
                  user={u}
                  orgId={orgId}
                  isAdmin={isAdmin}
                  currentUid={user.uid}
                  onDeactivate={handleDeactivate}
                  onEdit={() => setEditingUser(u)}
                  regionsById={regionsById}
                  allLocations={allLocations}
                />
              ))}
            </tbody>
          </table>
          </div>

          {hasMore && !search && (
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
          prefillEmail={approveReq?.email || ''}
          prefillName={approveReq?.name || ''}
          orgId={orgId}
          onClose={() => { setShowInvite(false); setApproveReq(null); }}
          onSuccess={handleInviteSent}
        />
      )}

    </div>
  );
}
