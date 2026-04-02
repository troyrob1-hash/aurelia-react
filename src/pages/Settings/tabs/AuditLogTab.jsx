// src/pages/Settings/tabs/AuditLogTab.jsx
import { useState, useEffect, useCallback } from "react";
import {
  collection, query, orderBy,
  limit, startAfter, getDocs, where
} from "firebase/firestore";
import { db }      from "../../../firebase";
import { useAuth } from "../../../hooks/useAuth";
import { formatDistanceToNow, format } from "date-fns";
import Spinner     from "../../../components/Spinner";
import EmptyState  from "../../../components/EmptyState";

const PAGE_SIZE = 25;

const ACTION_META = {
  "user.invited":             { label: "User invited",          color: "badge-blue"   },
  "user.activated":           { label: "User activated",        color: "badge-green"  },
  "user.deactivated":         { label: "User deactivated",      color: "badge-red"    },
  "user.role_changed":        { label: "Role changed",          color: "badge-amber"  },
  "user.updated":             { label: "User updated",          color: "badge-gray"   },
  "user.created":             { label: "User created",          color: "badge-blue"   },
  "user.login":               { label: "Login",                 color: "badge-gray"   },
  "user.login_failed":        { label: "Login failed",          color: "badge-red"    },
  "user.permissions_changed": { label: "Permissions changed",   color: "badge-amber"  },
  "location.created":         { label: "Location created",      color: "badge-blue"   },
  "location.updated":         { label: "Location updated",      color: "badge-gray"   },
  "location.deactivated":     { label: "Location deactivated",  color: "badge-red"    },
  "apiKey.created":           { label: "API key added",         color: "badge-blue"   },
  "apiKey.revoked":           { label: "API key revoked",       color: "badge-red"    },
  "apiKey.accessed":          { label: "API key revealed",      color: "badge-amber"  },
  "settings.updated":         { label: "Settings updated",      color: "badge-gray"   },
};

const RESOURCE_FILTERS = ["all", "user", "location", "apiKey"];

export default function AuditLogTab() {
  const { orgId } = useAuth();

  const [events,      setEvents]      = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastDoc,     setLastDoc]     = useState(null);
  const [hasMore,     setHasMore]     = useState(true);
  const [filter,      setFilter]      = useState("all");
  const [expanded,    setExpanded]    = useState(null);
  const [error,       setError]       = useState(null);

  const fetchEvents = useCallback(async (cursor = null) => {
    cursor ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      let q = query(
        collection(db, "orgs", orgId, "auditLog"),
        orderBy("createdAt", "desc"),
        limit(PAGE_SIZE)
      );
      if (filter !== "all") q = query(q, where("resourceType", "==", filter));
      if (cursor) q = query(q, startAfter(cursor));

      const snap = await getDocs(q);
      const docs = snap.docs.map(d => d.data());
      setEvents(prev => cursor ? [...prev, ...docs] : docs);
      setLastDoc(snap.docs[snap.docs.length - 1] ?? null);
      setHasMore(snap.docs.length === PAGE_SIZE);
    } catch (e) {
      setError("Failed to load audit log.");
      console.error(e);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [orgId, filter]);

  useEffect(() => { setExpanded(null); fetchEvents(); }, [fetchEvents]);

  const formatTime = (ts) => {
    if (!ts) return "—";
    const date = ts.toDate?.() ?? new Date(ts);
    return `${format(date, "MMM d, yyyy h:mm a")} (${formatDistanceToNow(date, { addSuffix: true })})`;
  };

  return (
    <div className="tab-content">
      <div className="tab-toolbar">
        <div className="filter-group">
          {RESOURCE_FILTERS.map(f => (
            <button key={f} className={`filter-btn ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
              {f === "all" ? "All activity" : f.charAt(0).toUpperCase() + f.slice(1) + "s"}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
          Read-only — immutable record
        </span>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? <Spinner /> : events.length === 0 ? (
        <EmptyState title="No activity yet" description="Actions taken by admins and users will appear here." />
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: "22%" }}>When</th>
                <th style={{ width: "18%" }}>Who</th>
                <th style={{ width: "22%" }}>Action</th>
                <th style={{ width: "18%" }}>Resource</th>
                <th style={{ width: "12%" }}>IP</th>
                <th style={{ width: "8%"  }}></th>
              </tr>
            </thead>
            <tbody>
              {events.map(ev => {
                const meta   = ACTION_META[ev.action] ?? { label: ev.action, color: "badge-gray" };
                const isOpen = expanded === ev.eventId;
                return [
                  <tr key={ev.eventId} onClick={() => setExpanded(e => e === ev.eventId ? null : ev.eventId)} style={{ cursor: "pointer" }}>
                    <td style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                      {ev.createdAt ? formatDistanceToNow(ev.createdAt.toDate(), { addSuffix: true }) : "—"}
                    </td>
                    <td>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{ev.actor?.displayName ?? "System"}</div>
                      <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{ev.actor?.email ?? ""}</div>
                    </td>
                    <td><span className={`badge ${meta.color}`}>{meta.label}</span></td>
                    <td style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                      {ev.resourceType} / <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{ev.resourceId?.slice(0, 8)}…</span>
                    </td>
                    <td style={{ fontSize: 11, color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}>{ev.actor?.ip ?? "—"}</td>
                    <td style={{ textAlign: "right", fontSize: 12, color: "var(--color-text-tertiary)" }}>{isOpen ? "▲" : "▼"}</td>
                  </tr>,
                  isOpen && (
                    <tr key={`${ev.eventId}-detail`}>
                      <td colSpan={6} style={{ padding: 0 }}>
                        <div style={{ background: "var(--color-background-secondary)", padding: "1rem 1.25rem", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", fontSize: 12 }}>
                          <div>
                            <div style={{ fontWeight: 500, marginBottom: 6, color: "var(--color-text-tertiary)", textTransform: "uppercase", fontSize: 11, letterSpacing: ".05em" }}>Event details</div>
                            {[
                              ["Event ID",      <span style={{ fontFamily: "var(--font-mono)" }}>{ev.eventId}</span>],
                              ["Timestamp",     formatTime(ev.createdAt)],
                              ["Action",        ev.action],
                              ["Resource type", ev.resourceType],
                              ["Resource ID",   <span style={{ fontFamily: "var(--font-mono)" }}>{ev.resourceId}</span>],
                              ["IP",            ev.actor?.ip ?? "—"],
                              ["User agent",    ev.actor?.userAgent ?? "—"],
                            ].map(([label, val]) => (
                              <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "4px 0", borderBottom: "0.5px solid var(--color-border-tertiary)", color: "var(--color-text-secondary)" }}>
                                <span style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>{label}</span>
                                <span style={{ textAlign: "right", wordBreak: "break-all" }}>{val}</span>
                              </div>
                            ))}
                          </div>
                          {ev.after && (
                            <div>
                              <div style={{ fontWeight: 500, marginBottom: 6, color: "var(--color-text-tertiary)", textTransform: "uppercase", fontSize: 11, letterSpacing: ".05em" }}>Changes</div>
                              <pre style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 6, padding: "8px 10px", fontSize: 11, fontFamily: "var(--font-mono)", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--color-text-primary)", margin: 0 }}>
                                {JSON.stringify(ev.after, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                ];
              })}
            </tbody>
          </table>

          {hasMore && (
            <button className="load-more-btn" onClick={() => fetchEvents(lastDoc)} disabled={loadingMore}>
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}