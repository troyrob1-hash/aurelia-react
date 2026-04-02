// src/pages/Settings/tabs/UsersTab.jsx
import { useState, useEffect, useCallback } from "react";
import { db, functions }   from "@/lib/firebase";
import { httpsCallable }   from "firebase/functions";
import {
  collection, query, orderBy,
  limit, startAfter, getDocs, where
} from "firebase/firestore";
import { useAuth }         from "@/hooks/useAuth";
import InviteModal         from "../components/InviteModal";
import UserRow             from "../components/UserRow";
import EmptyState          from "@/components/ui/EmptyState";
import Spinner             from "@/components/ui/Spinner";

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
  const [filter,      setFilter]      = useState("all");
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
    fetchUsers();
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